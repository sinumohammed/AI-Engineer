// Eval harness for the combined agent. Each case is a real regression test
// drawn from bugs actually found and fixed this project (Phase 6.8's
// hallucination bug, the always-retrieve fix, Phase 5.6's identifier
// mismatch, etc). AGENT_MODULE lets Phase 8 point this SAME harness (same
// questions, same assertions) at a different agent implementation - e.g.
// `AGENT_MODULE=../phase8-framework/agent-a.js npm run eval` - so framework
// comparisons are measured, not eyeballed.
const AGENT_MODULE = process.env.AGENT_MODULE ?? "../api/agent.js";
const { runAgent } = await import(AGENT_MODULE);

// The assertions check the MEANING of an answer, not one model's exact
// wording. Found by swapping models (Phase 8 re-run, then gemma3:4b): correct
// answers failed on phrasing alone - "I do not have information" vs "don't
// have information", "10 AM" vs "10am", a curly apostrophe in "don’t". So a
// mustContain entry may be an array of acceptable phrasings (any one passes),
// and check() normalizes apostrophes before comparing.
// Phase 10: Groq's gpt-oss-120b added "10 a.m.", "don't have any information",
// "don't have access to" and "not aware of" - checked by reading each answer:
// all correct. gpt-oss words the same answer differently from run to run.
const REFUSAL = [
  "don't know",
  "do not know",
  "don't have information",
  "do not have information",
  "don't contain information",
  "do not contain information",
  "doesn't contain information",
  "does not contain information",
  "don't have any information",
  "do not have any information",
  "don't have access",
  "do not have access",
  "not aware of",
];

const cases = [
  {
    name: "rollback process - grounded in company doc",
    question: "What is our rollback process?",
    mustContain: [["re-deploying", "re-deploy", "redeploy"], "tagged release"],
  },
  {
    name: "on-call handoff - regression test for the Phase 6.8 hallucination bug (model once answered '10 PM UTC', real answer is Monday 10am)",
    question: "When does the on-call rotation hand off?",
    mustContain: ["monday", ["10am", "10 am", "10:00 am", "10 a.m."]],
  },
  {
    name: "general knowledge - must NOT be derailed by always-on retrieval",
    question: "What is the capital of France?",
    mustContain: ["paris"],
  },
  {
    // Phase 9: this case assumed the documents say nothing about backups.
    // True with 2 sample docs; no longer true with the 241-page handbook,
    // which describes backups in general ("periodic snapshots...") without
    // giving a schedule. The honest answer is now either a refusal or "the
    // documents do not specify a schedule" - both accepted. What it still
    // guards against is an invented schedule.
    name: "out-of-domain company question - must admit not knowing, not hallucinate",
    question: "What is our database backup schedule?",
    mustContain: [
      [...REFUSAL, "not specified", "do not specify", "does not specify", "doesn't specify", "don't specify", "not explicitly stated", "not stated"],
    ],
    mustNotContain: ["every night", "nightly", "daily at", "every day at", "weekly on"],
  },
  {
    name: "repeated question in same turn context - regression test for Phase 6.8's temp-0 skip-and-hallucinate case",
    question: "What is our rollback process?",
    mustContain: [["re-deploying", "re-deploy", "redeploy"], "tagged release"],
  },
  {
    name: "equipment code (correct) - hybrid search must still answer when the exact ID is present",
    question: "What is the calibration schedule for XJ-2200?",
    mustContain: ["90 days"],
  },
  {
    name: "equipment code (wrong) - regression test for Phase 5.6's identifier-mismatch false positive (vector search alone scored a made-up code nearly as close as the real one)",
    question: "What is the calibration schedule for XJ-9999?",
    mustContain: [REFUSAL],
    mustNotContain: ["2200", "90 days"],
  },
  {
    // Phase 10: found by hand on Groq. Search sees only the latest message,
    // and "it" names nothing: qwen's relevance judging kept the FMLA
    // eligibility excerpt among four loose matches; gpt-oss-120b, judging
    // strictly, kept only the transit benefit and the agent said "I don't know".
    name: "follow-up question - search must understand 'it' from the conversation (Phase 10)",
    question: "And who is eligible for it?",
    history: [
      { role: "user", content: "How many weeks of unpaid leave does FMLA entitle me to?" },
      { role: "assistant", content: "FMLA entitles you to 12 unpaid weeks every 52 weeks [1]." },
    ],
    mustContain: [["one year of federal service", "1 year of federal service", "a year of federal service"]],
  },
  {
    // Phase 10: found by using the deployed app. "tell that in malayalam" was
    // searched as a new question and got "I don't have information about that
    // in the company documents". Requests to rework the previous answer are
    // now answered from the conversation (rework.js). English and French
    // here: the local model takes minutes to write Malayalam.
    name: "rework the previous answer - shorter (Phase 10)",
    question: "make it shorter",
    history: [
      { role: "user", content: "Who is eligible for FMLA?" },
      { role: "assistant", content: "To be eligible for FMLA, you must have at least one year of federal service [1]. Most veterans are immediately eligible [1].", fromCompanyDocs: true },
    ],
    mustContain: [["year", "1 yr"], "federal"],
    mustNotContain: ["company documents", "don't have information"],
  },
  {
    name: "rework the previous answer - translate (Phase 10)",
    question: "translate that into French",
    history: [
      { role: "user", content: "Who is eligible for FMLA?" },
      { role: "assistant", content: "To be eligible for FMLA, you must have at least one year of federal service [1]. Most veterans are immediately eligible [1].", fromCompanyDocs: true },
    ],
    mustContain: [["fédéral", "federal"], ["an ", "année"]],
    mustNotContain: ["company documents", "don't have information"],
  },
];

function check(answer, mustContain = [], mustNotContain = []) {
  const normalize = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
  const text = normalize(answer);
  const missing = mustContain
    .filter((s) => ![s].flat().some((alt) => text.includes(normalize(alt))))
    .map((s) => [s].flat().join(" | "));
  const forbidden = mustNotContain.filter((s) => text.includes(normalize(s)));
  return { passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

let passCount = 0;
const failures = [];

console.log(`Running ${cases.length} eval cases against ${AGENT_MODULE}...\n`);

for (const c of cases) {
  const start = Date.now();
  const { answer } = await runAgent(c.question, c.history ?? []);
  const elapsedMs = Date.now() - start;
  const result = check(answer, c.mustContain, c.mustNotContain);
  console.log(c.name,answer)
  if (result.passed) {
    passCount++;
    console.log(`✅ PASS  (${elapsedMs}ms)  ${c.name}`);
  } else {
    failures.push({ ...c, answer, ...result });
    console.log(`❌ FAIL  (${elapsedMs}ms)  ${c.name}`);
    console.log(`   question: ${c.question}`);
    console.log(`   answer:   ${answer}`);
    if (result.missing.length) console.log(`   missing expected text: ${result.missing.join(", ")}`);
    if (result.forbidden.length) console.log(`   contained forbidden text: ${result.forbidden.join(", ")}`);
  }
}

console.log(`\n${passCount}/${cases.length} passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED - see details above.`);
  process.exit(1);
}
process.exit(0);
