// Phase 9: retrieval eval. Every eval before this one checked the final
// ANSWER. With 2 chunks in the corpus that was enough - search could not miss.
// With 2,300 chunks the first question is whether search found the passage at
// all, before any model reads it. This measures that, with no model call.
//
// For each question it reports the rank of the first retrieved chunk that
// contains the answer passage:
//   hit@1  - the top result has the answer
//   hit@4  - it is within the 4 chunks the agent is actually given (TOP_K)
//   hit@10 - search found it, but too low for the agent to ever see
//   MRR    - mean of 1/rank, a single number for "how high up, on average"
// "agent sees it" runs the real retrieval step the agents use (retrieve.js):
// vector + keyword search, then - from step 9.4, unless RERANK=0 - the
// model's judgement of which candidates answer the question.
//
// EVAL_TABLE points the vector part at another chunk table, to compare
// chunking experiments (see ingest.js, INGEST_TABLE).
import { existsSync, readFileSync } from "node:fs";
import { vectorSearch, countChunksContaining } from "../phase5-rag/tools.js";
import { retrieve, RERANK } from "../phase5-rag/retrieve.js";
import { RELEVANCE_THRESHOLD } from "../phase5-rag/config.js";
import { direct, paraphrased, original, offTopic } from "./cases.js";

const TABLE = process.env.EVAL_TABLE ?? "doc_chunks";
const K = 10;
const AGENT_K = 4;
// Private cases live next to the private documents, outside git. The public
// numbers above them are reproducible from the repo alone.
const PRIVATE_CASES = new URL("../phase5-rag/docs-private/eval-cases.json", import.meta.url);

// Compare text as a reader sees it, so raw and cleaned chunks (step 9.2) are
// judged the same way: drop link addresses and markdown emphasis characters,
// ignore case and line breaks. Must match countChunksContaining in tools.js.
const retrieveMs = [];

const normalize = (s) =>
  s
    .replace(/\]\((?:<[^>]*>|[^)]*)\)/g, "")
    .replace(/[[\]_*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
const contains = (chunk, text) => normalize(chunk.content).includes(normalize(text));

async function runGroup(name, cases) {
  const results = [];
  for (const c of cases) {
    const rows = await vectorSearch(c.question, { k: K, table: TABLE });
    const index = rows.findIndex((r) => contains(r, c.mustFind));
    const rank = index === -1 ? null : index + 1;

    // Only meaningful on the live table - retrieval always reads doc_chunks.
    let agentSees = null;
    if (TABLE === "doc_chunks") {
      const startedAt = Date.now();
      const r = await retrieve(c.question);
      retrieveMs.push(Date.now() - startedAt);
      agentSees = r.isRelevant && r.chunks.some((chunk) => contains(chunk, c.mustFind));
    }

    // A miss has two different causes: search ranked the chunk too low, or
    // no single chunk contains the passage (a chunk boundary cut it in two).
    const inAnyChunk = rank !== null || (await countChunksContaining(c.mustFind, TABLE)) > 0;

    results.push({ ...c, rank, agentSees, inAnyChunk, topDistance: rows[0]?.distance, topSource: rows[0]?.source });
  }

  const n = results.length;
  const hitAt = (k) => results.filter((r) => r.rank !== null && r.rank <= k).length;
  const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;

  console.log(`\n${name}: ${n} cases`);
  for (const r of results) {
    const rankText = r.rank ? `rank ${String(r.rank).padStart(2)}` : r.inAnyChunk ? "not in top 10" : "SPLIT by chunking";
    const agentText = r.agentSees === null ? "" : r.agentSees ? "  agent sees it" : "  agent MISSES it";
    console.log(`  ${r.rank && r.rank <= AGENT_K ? "✅" : "❌"} ${rankText}${agentText}  ${r.question}`);
    if (!r.rank) console.log(`       top result instead: ${r.topSource} (${r.topDistance.toFixed(3)})`);
  }
  const agentHits = results.filter((r) => r.agentSees).length;
  console.log(
    `  => hit@1 ${hitAt(1)}/${n}   hit@${AGENT_K} ${hitAt(AGENT_K)}/${n}   hit@${K} ${hitAt(K)}/${n}   MRR ${mrr.toFixed(2)}` +
      (TABLE === "doc_chunks" ? `   agent sees it ${agentHits}/${n}` : "")
  );
  return results;
}

console.log(`Retrieval eval on table "${TABLE}"${TABLE === "doc_chunks" ? `, ${RERANK ? "with" : "without"} model reranking` : ""}`);
const all = [
  ...(await runGroup("Direct wording", direct)),
  ...(await runGroup("Paraphrased", paraphrased)),
  ...(await runGroup("Original sample docs", original)),
];
if (existsSync(PRIVATE_CASES)) {
  await runGroup("Private docs (not in git)", JSON.parse(readFileSync(PRIVATE_CASES, "utf-8")));
} else {
  console.log("\nPrivate docs: no docs-private/eval-cases.json on this machine, skipped.");
}

// Relevant vs irrelevant: is there still a gap a threshold can sit in?
const relevantTop = all.filter((r) => r.rank === 1).map((r) => r.topDistance);
console.log(`\nOff-topic questions: ${offTopic.length} (search should call none of these relevant)`);
const offTop = [];
let falsePositives = 0;
for (const q of offTopic) {
  const rows = await vectorSearch(q, { k: 1, table: TABLE });
  const distance = rows[0].distance;
  offTop.push(distance);
  let flagged = distance < RELEVANCE_THRESHOLD;
  if (TABLE === "doc_chunks") flagged = (await retrieve(q)).isRelevant;
  if (flagged) falsePositives++;
  console.log(`  ${flagged ? "❌ treated as relevant" : "✅ not relevant       "}  ${distance.toFixed(3)}  ${q}`);
}
const range = (xs) => (xs.length ? `${Math.min(...xs).toFixed(3)} - ${Math.max(...xs).toFixed(3)}` : "n/a");
const gate = TABLE !== "doc_chunks" || !RERANK ? `threshold ${RELEVANCE_THRESHOLD}` : "model-judged relevance";
console.log(`  => ${falsePositives}/${offTopic.length} wrongly treated as relevant (${gate})`);
if (retrieveMs.length) {
  const avg = Math.round(retrieveMs.reduce((a, b) => a + b, 0) / retrieveMs.length);
  console.log(`\nRetrieval step: average ${avg} ms per question (${RERANK ? "search + model judgement" : "search only"})`);
}
console.log(`\nBest-match distance, correct top result:  ${range(relevantTop)}`);
console.log(`Best-match distance, off-topic question:  ${range(offTop)}`);

process.exit(0);
