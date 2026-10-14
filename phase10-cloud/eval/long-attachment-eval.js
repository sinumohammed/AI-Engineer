// Phase 10, attachments step 2: a long PDF (samples/irs-pub15-employers-tax-
// guide.pdf, IRS Publication 15, 59 pages, ~300,000 characters - public
// domain). Step 1 kept its first ~12,000 characters, about 3 pages.
//
//   1. search: for each fact question, does a chunk containing the fact
//      reach the prompt? (no model call; step 1's text is the baseline)
//   2. which questions get the file: unrelated questions must not
//   3. answers (ANSWERS=1): the agent answers from the file
//      (AGENT=multi for the supervisor; ONLY=<text> runs matching cases)
//   4. (with ANSWERS=1) a short file is still cited as itself
//
// Embeddings come from EMBED_PROVIDER in .env (Ollama on the Mac). Part 3
// costs model quota; parts 1-2 do not.
import { readFileSync } from "node:fs";
import { readAttachment, attachmentChunk, fileForQuestion, MAX_CHARS } from "../api/attachments.js";
import { POINTS_BACK } from "../api/retrieve.js";

const FILE = new URL("./samples/irs-pub15-employers-tax-guide.pdf", import.meta.url);
const ONLY = process.env.ONLY?.toLowerCase();

// `fact`: text the right chunk contains, and any acceptable answer has.
const facts = [
  { q: "What is the FUTA tax rate for 2026, and on how much of each employee's wages?", fact: "6.0%", answer: [["6.0%", "6%"], "7,000"] },
  { q: "At what amount of wages do I stop collecting the employee share of social security tax in 2026?", fact: "184,500", answer: ["184,500"] },
  { q: "When do I have to start withholding Additional Medicare Tax?", fact: "200,000", answer: ["200,000"] },
  { q: "What withholding rate applies to supplemental wages over $1 million?", fact: "37%", answer: ["37%"] },
  { q: "If an employee gets bonuses adding up to more than a million dollars in a year, what rate do I withhold on the excess?", fact: "37%", answer: ["37%"] },
  { q: "What decides whether I am a monthly or a semiweekly depositor?", fact: "lookback period", answer: ["lookback"] },
  { q: "What happens if I accumulate $100,000 or more in tax liability on any day?", fact: "next business day", answer: [["next business day", "next day", "following business day"]] },
  { q: "What rate is used for backup withholding?", fact: "24%", answer: ["24%"] },
];
// The file was sent with an earlier message; these must not get it.
const unrelated = [
  "What is our rollback process?",
  "When does the on-call rotation hand off?",
  "What is the capital of France?",
  "How do I list git tags?",
  "How much paid parental leave do I get?",
  "What is the calibration schedule for XJ-2200?",
];
const related = ["What is the social security wage base?", "How do I deposit FUTA tax?", "What does the PDF say about tips?"];

const started = Date.now();
const att = await readAttachment(readFileSync(FILE), "application/pdf", "irs-pub15-employers-tax-guide.pdf");
const readMs = Date.now() - started;
const stored = JSON.stringify(att).length;
console.log(`Read ${att.pages} pages in ${readMs} ms: ${att.chunks?.length ?? 0} chunks, pages 1-${att.pagesRead}, ${(stored / 1024).toFixed(0)} KB stored`);
console.log(`Overview: ${att.overview?.slice(0, 300)}${att.overview?.length > 300 ? "..." : ""}\n`);

// Step 1's view of the same file: whole pages while they fit MAX_CHARS.
const pageText = [];
for (const c of att.chunks) pageText[c.page - 1] = (pageText[c.page - 1] ?? "") + c.text + "\n";
let firstPages = "";
for (const p of pageText) {
  if (firstPages && firstPages.length + p.length > MAX_CHARS) break;
  firstPages += p;
}

let found = 0, baseline = 0, total = 0;
console.log("1. Search - does the fact reach the prompt?");
for (const f of facts) {
  if (ONLY && !f.q.toLowerCase().includes(ONLY)) continue;
  total++;
  const t = Date.now();
  const chunk = await attachmentChunk(att, f.q);
  const ok = chunk.content.includes(f.fact);
  const was = firstPages.includes(f.fact);
  found += ok;
  baseline += was;
  console.log(`${ok ? "✅" : "❌"} ${String(Date.now() - t).padStart(4)} ms  pages ${chunk.pages.join(",").padEnd(12)} ${f.q}${was ? "  (step 1 had it too)" : ""}`);
}
console.log(`   ${found}/${total} found (step 1: ${baseline}/${total}); prompt excerpt ~${Math.round((await attachmentChunk(att, facts[0].q)).content.length / 4)} tokens\n`);

console.log("2. Which questions get the file (sent with an earlier message)");
const sent = { ...att, sent: true };
let routed = 0;
for (const q of unrelated) {
  const gets = Boolean(fileForQuestion(sent, q, [], POINTS_BACK));
  routed += !gets;
  console.log(`${gets ? "❌ gets the file" : "✅ no file     "}  ${q}`);
}
for (const q of related) {
  const gets = Boolean(fileForQuestion(sent, q, [], POINTS_BACK));
  routed += gets;
  console.log(`${gets ? "✅ gets the file" : "❌ no file     "}  ${q}`);
}
console.log(`   ${routed}/${unrelated.length + related.length} right\n`);

if (process.env.ANSWERS === "1") {
  const multi = process.env.AGENT === "multi";
  const { runAgent } = await import("../api/agent.js");
  const { runMultiAgent } = await import("../api/multiAgent.js");
  const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
  let passed = 0, asked = 0;
  console.log(`3. Answers (${multi ? "supervisor" : "single agent"}), the file sent with each question`);
  for (const f of facts) {
    if (ONLY && !f.q.toLowerCase().includes(ONLY)) continue;
    asked++;
    const t = Date.now();
    const run = multi ? runMultiAgent : runAgent;
    const { answer } = await run(f.q, [], { attachment: att });
    const missing = f.answer.filter((m) => ![m].flat().some((alt) => norm(answer).includes(norm(alt))));
    const ok = missing.length === 0;
    passed += ok;
    console.log(`${ok ? "✅" : "❌"} ${String(Date.now() - t).padStart(6)} ms  ${f.q}`);
    if (!ok) console.log(`     ${answer.slice(0, 300).replace(/\n/g, " ")}`);
  }
  console.log(`   ${passed}/${asked} answered`);

  // A short file still goes in whole, and is cited as itself. Found
  // 2026-10-14: with no handbook match the file is excerpt [1], and qwen cited
  // its heading "3. Hotels" as [3], so no source was listed (citations.js).
  console.log(`\n4. Short file (travel-policy.pdf): answer and its source (${multi ? "supervisor" : "single agent"})`);
  const short = await readAttachment(readFileSync(new URL("./samples/travel-policy.pdf", import.meta.url)), "application/pdf", "travel-policy.pdf");
  let cited = 0;
  for (let i = 0; i < 3; i++) {
    const { answer, sources } = await (multi ? runMultiAgent : runAgent)("What is the hotel limit in Paris?", [], { attachment: short });
    const ok = answer.includes("220") && sources.some((s) => s.source === "travel-policy.pdf");
    cited += ok;
    console.log(`${ok ? "✅" : "❌"} ${answer.slice(0, 90).replace(/\n/g, " ")} | sources: ${sources.map((s) => `[${s.n}] ${s.source}`).join(", ") || "none"}`);
  }
  console.log(`   ${cited}/3 cite the file`);
}
process.exit(0);
