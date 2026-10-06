// Eval for the multi-agent supervisor. Two parts, because a multi-agent
// system can fail in two different places:
//   1. ROUTING  - did each question go to the right specialist(s)? Tested on
//      route() alone (one LLM call per case, no specialists run), so a wrong
//      hand-off is caught directly instead of being inferred from a bad answer.
//   2. END TO END - for questions that need two specialists, does the merged
//      answer still contain BOTH parts?
// The single-agent regression cases are not copied here: run them against
// the supervisor with `npm run eval:regression` (same harness, AGENT_MODULE).
// SUPERVISOR_MODULE points this same eval at another implementation of the
// supervisor (e.g. ./supervisor-graph.js) - same idea as AGENT_MODULE in
// phase7-reliability/eval.js.
const SUPERVISOR_MODULE = process.env.SUPERVISOR_MODULE ?? "../api/supervisor.js";
const { route, runAgent } = await import(SUPERVISOR_MODULE);
console.log(`Supervisor under test: ${SUPERVISOR_MODULE}\n`);

const routingCases = [
  // company questions
  { question: "What is our rollback process?", expect: ["company_docs"] },
  { question: "When does the on-call rotation hand off?", expect: ["company_docs"] },
  { question: "What is our database backup schedule?", expect: ["company_docs"] },
  { question: "What is the calibration schedule for XJ-2200?", expect: ["company_docs"] },
  { question: "Who has to approve a deploy before it goes to production here?", expect: ["company_docs"] },
  // coding questions
  { question: "How do I reverse a string in JavaScript?", expect: ["coding"] },
  { question: "Why does my Python loop throw IndexError: list index out of range?", expect: ["coding"] },
  { question: "Write a SQL query to find duplicate emails in a users table.", expect: ["coding"] },
  { question: "How do I list all git tags from the command line?", expect: ["coding"] },
  // general questions
  { question: "What is the capital of France?", expect: ["general"] },
  { question: "Who wrote Pride and Prejudice?", expect: ["general"] },
  { question: "How many minutes are there in a day?", expect: ["general"] },
  // needs two specialists
  {
    question: "What is our rollback process, and how do I list all git tags from the command line?",
    expect: ["coding", "company_docs"],
  },
  {
    question: "What is the capital of France, and when does our on-call rotation hand off?",
    expect: ["company_docs", "general"],
  },
  // Regression cases for a routing miss found in the chat UI: two-part
  // messages whose parts are close in topic (rollbacks + git tags - the doc
  // says "tagged release") were NOT split. Depending on the phrasing the
  // whole message went to company_docs alone, to coding alone, or the git
  // part was sent to company_docs. Fixed by making the router list the
  // message's parts before assigning agents (routing.js).
  { question: "How are rollbacks done, and how do I list git tags?", expect: ["coding", "company_docs"] },
  { question: "How are rollbacks done and how do I list git tags", expect: ["coding", "company_docs"] },
  { question: "How do I list git tags, and how are rollbacks done?", expect: ["coding", "company_docs"] },
  { question: "What is our rollback process and how do I create a git tag?", expect: ["coding", "company_docs"] },
  {
    question: "What is the calibration schedule for XJ-2200 and how do I reverse a string in JavaScript?",
    expect: ["coding", "company_docs"],
  },
  { question: "Who wrote Pride and Prejudice and how do I reverse a string in JavaScript?", expect: ["coding", "general"] },
  // two parts, same specialist - one or two tasks are both fine
  {
    question: "What is our rollback process and who approves a deploy before production?",
    expect: ["company_docs"],
  },
  // The hard one: nothing in the wording says "company", but the company has
  // a doc that answers it. The router only knows the specialists'
  // descriptions, not what the documents contain.
  { question: "How are rollbacks done?", expect: ["company_docs"], note: "no 'our' in the wording" },
  // The opposite trap: generic coding questions that sit close to the company
  // doc in embedding space (it mentions commits and CI builds) but are not
  // answered by it. A "distance under the threshold means company_docs" rule
  // would misroute both.
  { question: "How do I revert a commit in git?", expect: ["coding"], note: "close to the doc, not answered by it" },
  {
    question: "How do I set up a CI build with GitHub Actions?",
    expect: ["coding"],
    note: "close to the doc, not answered by it",
  },
];

const endToEndCases = [
  {
    question: "What is our rollback process, and how do I list all git tags from the command line?",
    mustContain: [["re-deploying", "redeploying", "re-deploy", "redeploy"], "tagged release", "git tag"],
  },
  {
    question: "What is the capital of France, and when does our on-call rotation hand off?",
    mustContain: ["paris", "monday", ["10am", "10 am", "10:00 am"]],
  },
  {
    question: "What is the calibration schedule for XJ-9999, and who wrote Pride and Prejudice?",
    mustContain: [
      "austen",
      [
        "don't have information",
        "do not have information",
        "don't have that information",
        "do not have that information",
        "don't know",
        "do not know",
      ],
    ],
    mustNotContain: ["2200", "90 days"],
  },
];

const normalize = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
// Compared as sets: two tasks for the same specialist count as that specialist once.
const sameAgents = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

let failed = 0;

console.log(`Routing: ${routingCases.length} cases\n`);
let routingPassed = 0;
for (const c of routingCases) {
  const r = await route(c.question);
  const got = r.tasks.map((t) => t.agent);
  const ok = sameAgents(got, c.expect);
  if (ok) routingPassed++;
  else failed++;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  (${r.latencyMs}ms)  ${c.question}${c.note ? `  [${c.note}]` : ""}`);
  console.log(`   -> ${got.join(" + ")}${r.fallback ? " (fallback)" : ""}${ok ? "" : `   expected: ${c.expect.join(" + ")}`}`);
  if (!ok) console.log(`   reason: ${r.reason}`);
}
console.log(`\nRouting: ${routingPassed}/${routingCases.length} passed.\n`);

console.log(`End to end (two specialists): ${endToEndCases.length} cases\n`);
let e2ePassed = 0;
for (const c of endToEndCases) {
  const { answer, trace } = await runAgent(c.question);
  const text = normalize(answer);
  const missing = c.mustContain
    .filter((s) => ![s].flat().some((alt) => text.includes(normalize(alt))))
    .map((s) => [s].flat().join(" | "));
  const forbidden = (c.mustNotContain ?? []).filter((s) => text.includes(normalize(s)));
  const ok = missing.length === 0 && forbidden.length === 0;
  if (ok) e2ePassed++;
  else failed++;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  (${trace.latencyMs}ms, ${trace.usage.llmCalls} LLM calls)  ${c.question}`);
  console.log(`   route: ${trace.steps.map((s) => s.agent).join(" + ")}`);
  if (!ok) {
    console.log(`   answer: ${answer}`);
    if (missing.length) console.log(`   missing expected text: ${missing.join(", ")}`);
    if (forbidden.length) console.log(`   contained forbidden text: ${forbidden.join(", ")}`);
  }
}
console.log(`\nEnd to end: ${e2ePassed}/${endToEndCases.length} passed.`);

// 3. SECOND-HAND ANSWERS - regression test for a bug found in the chat UI
// (Phase 8c): a specialist with no document access repeated the company's
// rollback process from an EARLIER ANSWER in the conversation history. An
// instruction in the prompt did not stop it (4 of 4 still leaked); hiding
// tagged answers from those specialists did (specialists.js, historyFor).
// Tested on the specialists directly - the code is shared by both supervisors.
const { runSpecialist } = await import("../api/specialists.js");
const historyWithCompanyAnswer = [
  { role: "user", content: "What is our rollback process?" },
  {
    role: "assistant",
    content: "Rollbacks are done by re-deploying the previous tagged release, not by reverting commits.",
    fromCompanyDocs: true,
  },
  // Two more ordinary turns. Not padding: with only ONE prior turn this model
  // answers "what did I ask first?" with a canned "I don't have access to our
  // conversation history" - measured with and without the redaction, so it is
  // a separate, older quirk (the Phase 6.11 refusal habit), not what this
  // section tests.
  { role: "user", content: "What is the capital of France?" },
  { role: "assistant", content: "The capital of France is Paris." },
  { role: "user", content: "How do I list git tags?" },
  { role: "assistant", content: "Use `git tag`." },
];
const historyCases = [
  { agent: "general", question: "what is rollback process", mustNotContain: ["tagged release"] },
  { agent: "coding", question: "rollback process", mustNotContain: ["tagged release"] },
  // the user's own questions must still be visible
  { agent: "general", question: "What was the first thing I asked you?", mustContain: ["rollback"] },
  // the specialist that CAN read documents is unaffected
  { agent: "company_docs", question: "What is our rollback process?", mustContain: ["tagged release"] },
];

console.log(`\nSecond-hand answers (history contains a company-document answer): ${historyCases.length} cases\n`);
let historyPassed = 0;
for (const c of historyCases) {
  const { answer } = await runSpecialist(c.agent, c.question, historyWithCompanyAnswer);
  const text = normalize(answer);
  const missing = (c.mustContain ?? []).filter((s) => !text.includes(normalize(s)));
  const forbidden = (c.mustNotContain ?? []).filter((s) => text.includes(normalize(s)));
  const ok = missing.length === 0 && forbidden.length === 0;
  if (ok) historyPassed++;
  else failed++;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  [${c.agent}]  ${c.question}`);
  if (!ok) {
    console.log(`   answer: ${answer}`);
    if (missing.length) console.log(`   missing expected text: ${missing.join(", ")}`);
    if (forbidden.length) console.log(`   contained forbidden text: ${forbidden.join(", ")}`);
  }
}
console.log(`\nSecond-hand answers: ${historyPassed}/${historyCases.length} passed.`);

process.exit(failed ? 1 : 0);
