// Phase 10: what the relevance judging costs, and whether a cheaper setting
// keeps its quality. Runs only the search + judging step (retrieve.js) for
// every public case: "agent sees it" exactly as retrieval-eval.js counts it,
// off-topic questions wrongly judged relevant, and the judging tokens per
// question - what Groq's 200,000-tokens-a-day limit is spent on.
// Compare settings with e.g. JUDGE_REASONING_EFFORT=low or RERANK_CANDIDATES=12.
// LIMIT=n runs only the first n cases of each group (token measurements).
// Stops cleanly, with what it has, if the provider's daily limit is reached.
import { retrieve, CANDIDATES } from "../api/retrieve.js";
import { JUDGE_MODEL, JUDGE_REASONING_EFFORT } from "../api/config.js";
import { direct, paraphrased, original, offTopic } from "./cases.js";

const LIMIT = Number(process.env.LIMIT ?? Infinity);
const normalize = (s) =>
  s
    .replace(/\]\((?:<[^>]*>|[^)]*)\)/g, "")
    .replace(/[[\]_*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
const contains = (chunk, text) => normalize(chunk.content).includes(normalize(text));

const usage = [];
let stopped = null;
async function judged(question) {
  const r = await retrieve(question);
  if (r.rerankUsage) usage.push(r.rerankUsage);
  return r;
}

console.log(
  `Judging cost: ${JUDGE_MODEL}, reasoning effort ${JUDGE_REASONING_EFFORT ?? "default"}, ` +
    `${CANDIDATES} candidates\n`
);
const groups = [["Direct", direct], ["Paraphrased", paraphrased], ["Original", original]];
for (const [name, all] of groups) {
  const cases = all.slice(0, LIMIT);
  let sees = 0, done = 0;
  for (const c of cases) {
    try {
      const r = await judged(c.question);
      if (r.isRelevant && r.chunks.some((chunk) => contains(chunk, c.mustFind))) sees++;
      else console.log(`  miss: ${c.question}`);
      done++;
    } catch (err) {
      stopped = err.message.slice(0, 160);
      break;
    }
  }
  console.log(`${name}: agent sees it ${sees}/${done}${done < cases.length ? ` (of ${cases.length})` : ""}`);
  if (stopped) break;
}
if (!stopped) {
  let wrong = 0, done = 0;
  for (const q of offTopic.slice(0, LIMIT)) {
    try {
      if ((await judged(q)).isRelevant) { wrong++; console.log(`  wrongly relevant: ${q}`); }
      done++;
    } catch (err) {
      stopped = err.message.slice(0, 160);
      break;
    }
  }
  console.log(`Off-topic wrongly relevant: ${wrong}/${done}`);
}

const avg = (k) => Math.round(usage.reduce((s, u) => s + u[k], 0) / Math.max(usage.length, 1));
console.log(
  `\nJudging calls: ${usage.length}, per question: ${avg("promptTokens")} prompt + ${avg("completionTokens")} ` +
    `completion (incl. hidden reasoning) = ${avg("promptTokens") + avg("completionTokens")} tokens`
);
if (stopped) console.log(`\nStopped early: ${stopped}`);
process.exit(0);
