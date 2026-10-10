// Phase 10: do questions in other languages find the English passage?
// Runs the real retrieval step (search + relevance judging, retrieve.js) on
// the same six facts in Malayalam, Hindi and Spanish, and checks that
// off-topic questions in those languages are still judged not relevant.
// TRANSLATE_SEARCH=0 searches with the question as written, to compare.
import { retrieve } from "../api/retrieve.js";
import { multilingual, multilingualOffTopic } from "./cases.js";

const normalize = (s) =>
  s
    .replace(/\]\((?:<[^>]*>|[^)]*)\)/g, "")
    .replace(/[[\]_*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

let found = 0;
let total = 0;
for (const [lang, cases] of Object.entries(multilingual)) {
  let hits = 0;
  console.log(`\n${lang}: ${cases.length} cases`);
  for (const c of cases) {
    const r = await retrieve(c.question);
    const hit = r.isRelevant && r.chunks.some((chunk) => normalize(chunk.content).includes(normalize(c.mustFind)));
    if (hit) hits++;
    console.log(`  ${hit ? "✅" : "❌"} ${c.question}${r.searchedAs ? `\n       searched as: ${r.searchedAs}` : ""}`);
  }
  console.log(`  => agent sees the answer ${hits}/${cases.length}`);
  found += hits;
  total += cases.length;
}

let falsePositives = 0;
console.log(`\nOff-topic: ${multilingualOffTopic.length} cases`);
for (const q of multilingualOffTopic) {
  const r = await retrieve(q);
  if (r.isRelevant) falsePositives++;
  console.log(`  ${r.isRelevant ? "❌ judged relevant" : "✅ not relevant"}  ${q}${r.searchedAs ? `  (as: ${r.searchedAs})` : ""}`);
}
console.log(`\nAnswer reaches the agent: ${found}/${total}   off-topic wrongly relevant: ${falsePositives}/${multilingualOffTopic.length}`);
process.exit(0);
