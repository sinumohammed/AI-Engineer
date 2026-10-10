// Phase 9.6: are the citations right? For every retrieval case, ask the real
// agent and check three things:
//   answered from docs - the answer used the documents and cited at least one excerpt
//   cites the answer   - one of the cited excerpts contains the answer passage (mustFind)
//   no stray numbers   - every [n] in the text points to an excerpt that exists
// AGENT=multi runs the multi-agent supervisor instead of the single agent.
import { existsSync, readFileSync } from "node:fs";
import { direct, paraphrased, original } from "./cases.js";
import { EMBED_PROVIDER, DATABASE_IS_LOCAL } from "../api/config.js";

const MULTI = process.env.AGENT === "multi";
const { runAgent } = await import(MULTI ? "../api/supervisor.js" : "../api/agent.js");
const PRIVATE_CASES = new URL("../../phase5-rag/docs-private/eval-cases.json", import.meta.url);

const normalize = (s) =>
  s
    .replace(/\]\((?:<[^>]*>|[^)]*)\)/g, "")
    .replace(/[[\]_*`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

async function runGroup(name, cases) {
  let cited = 0;
  let correct = 0;
  let stray = 0;
  console.log(`\n${name}: ${cases.length} cases`);
  for (const c of cases) {
    const { answer, sources = [] } = await runAgent(c.question, []);
    const numbers = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const strayHere = numbers.filter((n) => !sources.some((s) => s.n === n)).length;
    const hasAnswer = sources.some((s) => normalize(s.text).includes(normalize(c.mustFind)));
    if (sources.length) cited++;
    if (hasAnswer) correct++;
    if (strayHere) stray++;
    const mark = hasAnswer ? "✅" : sources.length ? "🟡" : "❌";
    console.log(`  ${mark} ${sources.length} cited${strayHere ? `, ${strayHere} stray` : ""}  ${c.question}`);
    if (!hasAnswer) console.log(`       ${answer.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  const n = cases.length;
  console.log(`  => answered from docs ${cited}/${n}   cites the answer ${correct}/${n}   answers with stray numbers ${stray}/${n}`);
}

// Phase 10: GROUPS=paraphrased,original runs only those groups - to finish a
// run on Groq that stopped at the daily limit without repeating the rest.
const GROUPS = process.env.GROUPS?.split(",").map((g) => g.trim());
const wanted = (key) => !GROUPS || GROUPS.includes(key);

console.log(`Citation eval - ${MULTI ? "multi-agent supervisor" : "single agent"}`);
if (wanted("direct")) await runGroup("Direct wording", direct);
if (wanted("paraphrased")) await runGroup("Paraphrased", paraphrased);
if (wanted("original")) await runGroup("Original sample docs", original);
// Phase 10: private documents are only in tables embedded by local Ollama.
if (EMBED_PROVIDER !== "gemini" && DATABASE_IS_LOCAL && existsSync(PRIVATE_CASES)) await runGroup("Private docs (not in git)", JSON.parse(readFileSync(PRIVATE_CASES, "utf-8")));
process.exit(0);
