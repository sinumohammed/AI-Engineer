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
const REFUSAL = [
  "don't know",
  "do not know",
  "don't have information",
  "do not have information",
  "don't contain information",
  "do not contain information",
  "doesn't contain information",
  "does not contain information",
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
    mustContain: ["monday", ["10am", "10 am", "10:00 am"]],
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
  const { answer } = await runAgent(c.question, []);
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
