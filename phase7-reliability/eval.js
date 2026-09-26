// Eval harness for the combined agent (phase6-ui/server/agent.js). Each case
// is a real regression test drawn from bugs actually found and fixed this
// project (Phase 6.8's hallucination bug, the always-retrieve fix, etc) -
// this is the safety net Phase 8 needs before comparing against a rewritten
// (e.g. LangChain) version of the same agent.
import { runAgent } from "../phase6-ui/server/agent.js";

const cases = [
  {
    name: "rollback process - grounded in company doc",
    question: "What is our rollback process?",
    mustContain: ["re-deploying", "tagged release"],
  },
  {
    name: "on-call handoff - regression test for the Phase 6.8 hallucination bug (model once answered '10 PM UTC', real answer is Monday 10am)",
    question: "When does the on-call rotation hand off?",
    mustContain: ["monday", "10am"],
  },
  {
    name: "general knowledge - must NOT be derailed by always-on retrieval",
    question: "What is the capital of France?",
    mustContain: ["paris"],
  },
  {
    name: "out-of-domain company question - must admit not knowing, not hallucinate",
    question: "What is our database backup schedule?",
    mustContain: ["don't know"],
  },
  {
    name: "repeated question in same turn context - regression test for Phase 6.8's temp-0 skip-and-hallucinate case",
    question: "What is our rollback process?",
    mustContain: ["re-deploying", "tagged release"],
  },
  {
    name: "equipment code (correct) - hybrid search must still answer when the exact ID is present",
    question: "What is the calibration schedule for XJ-2200?",
    mustContain: ["90 days"],
  },
  {
    name: "equipment code (wrong) - regression test for Phase 5.6's identifier-mismatch false positive (vector search alone scored a made-up code nearly as close as the real one)",
    question: "What is the calibration schedule for XJ-9999?",
    mustContain: ["don't have information"],
    mustNotContain: ["2200", "90 days"],
  },
];

function check(answer, mustContain = [], mustNotContain = []) {
  const lower = answer.toLowerCase();
  const missing = mustContain.filter((s) => !lower.includes(s.toLowerCase()));
  const forbidden = mustNotContain.filter((s) => lower.includes(s.toLowerCase()));
  return { passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

let passCount = 0;
const failures = [];

console.log(`Running ${cases.length} eval cases against the combined agent...\n`);

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
