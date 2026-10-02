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
const SUPERVISOR_MODULE = process.env.SUPERVISOR_MODULE ?? "./supervisor.js";
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
    mustContain: ["austen", ["don't have information", "do not have information", "don't know", "do not know"]],
    mustNotContain: ["2200", "90 days"],
  },
];

const normalize = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
const sameAgents = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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

process.exit(failed ? 1 : 0);
