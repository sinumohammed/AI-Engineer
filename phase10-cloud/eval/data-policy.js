// Phase 10 #3: the data policy (api/dataPolicy.js) - which documents go to
// which services. No model calls, so it costs no Groq or Gemini quota:
//   1. search: confidential chunks reach a local model, never a hosted one
//   2. ingest: which folders may go into which database, embedded by whom
//   3. attachments: photos and scans go to Gemini only where GEMINI_FILES allows
//   4. what the attach button tells the user
//
// The policy is decided once, from the settings, when its module loads - so
// every setup runs in its own child process (this file with --probe).
// Part 1 needs the local Postgres with docs-private ingested (scripts/ingest.js).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const LOCAL_DB = "postgres://rag:rag@localhost:5432/rag";
const HOSTED_DB = "postgres://user:pw@ep-example.eu-central-1.aws.neon.tech/neondb";

if (process.argv[2] === "--probe") {
  const what = process.argv[3];
  const policy = await import("../api/dataPolicy.js");
  const out = { modelIsLocal: policy.MODEL_IS_LOCAL, filesGoTo: policy.FILES_GO_TO, geminiFiles: policy.GEMINI_FILES };
  out.ingest = Object.fromEntries(policy.ingestPlan().map((l) => [l.level, l.allowed]));
  if (what === "search") {
    const { toolImpls, vectorSearch } = await import("../api/tools.js");
    const sources = [];
    for (const q of ["What are the engineering salary bands?", "Who is the first escalation contact for a production outage?"]) {
      const found = await toolImpls.search_company_docs({ query: q, k: 10 });
      if (!Array.isArray(found)) throw new Error(`search failed: ${JSON.stringify(found)}`);
      sources.push(...found.map((r) => r.source), ...(await vectorSearch(q, { k: 10 })).map((r) => r.source));
    }
    out.privateFound = sources.filter((s) => s.startsWith("private/")).length;
    out.searched = sources.length;
  }
  if (what === "attach") {
    const { readAttachment } = await import("../api/attachments.js");
    out.files = {};
    for (const [name, type] of [["receipt.png", "image/png"], ["scanned.pdf", "application/pdf"], ["travel-policy.pdf", "application/pdf"]]) {
      try {
        const att = await readAttachment(readFileSync(new URL(`./samples/${name}`, import.meta.url)), type, name);
        out.files[name] = `read by ${att.readBy}`;
      } catch (err) {
        out.files[name] = `refused ${err.status}`;
      }
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

// One setup: the .env as on the Mac, with these settings on top.
function probe(what, env) {
  const clean = { ...process.env };
  for (const k of ["LLM_PROVIDER", "LLM_BASE_URL", "DATABASE_URL", "EMBED_PROVIDER", "GEMINI_FILES", "VERCEL"]) delete clean[k];
  const out = execFileSync(process.execPath, ["--env-file=../.env", SELF, "--probe", what], {
    cwd: new URL(".", import.meta.url),
    env: { ...clean, DATABASE_URL: LOCAL_DB, ...env },
    encoding: "utf-8",
  });
  return JSON.parse(out.trim().split("\n").at(-1));
}

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += ok;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${detail}` : ""}`);
}

const LOCAL = { LLM_PROVIDER: "ollama" };
const GROQ = { LLM_PROVIDER: "groq" };

console.log("1. Search: confidential chunks only reach a local model");
const local = probe("search", LOCAL);
check("Ollama: the salary and escalation questions find the private document", local.privateFound > 0, `${local.privateFound} of ${local.searched} results private`);
const hosted = probe("search", GROQ);
check("Groq, same local table: no private result", hosted.privateFound === 0, `${hosted.privateFound} of ${hosted.searched} results private`);
const openaiLocal = probe("search", { LLM_PROVIDER: "openai", LLM_BASE_URL: "http://localhost:11434/v1" });
check("OpenAI format at localhost counts as local", openaiLocal.modelIsLocal && openaiLocal.privateFound > 0);

console.log("\n2. Ingest: which levels go where");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [label, env, want] of [
  ["Mac (local Postgres, Ollama embeddings)", {}, { public: true, internal: true, confidential: true }],
  ["Neon, in-process embeddings (the live table)", { DATABASE_URL: HOSTED_DB, EMBED_PROVIDER: "local" }, { public: true, internal: true, confidential: false }],
  ["Local Postgres, Gemini embeddings", { EMBED_PROVIDER: "gemini" }, { public: true, internal: false, confidential: false }],
  ["Neon, Gemini embeddings", { DATABASE_URL: HOSTED_DB, EMBED_PROVIDER: "gemini" }, { public: true, internal: false, confidential: false }],
]) {
  const { ingest } = probe("plan", env);
  check(label, same(ingest, want), Object.entries(ingest).filter(([, v]) => v).map(([k]) => k).join(", "));
}

console.log("\n3. Attachments: Gemini only where GEMINI_FILES allows");
const mac = probe("attach", LOCAL);
check("Mac default: photo and scanned PDF refused, nothing sent to Gemini", !mac.geminiFiles && mac.files["receipt.png"] === "refused 501" && mac.files["scanned.pdf"] === "refused 501");
check("Mac default: a PDF with text is still read, here", mac.files["travel-policy.pdf"] === "read by text");
check("Vercel default: Gemini on", probe("plan", { ...GROQ, VERCEL: "1" }).geminiFiles === true);
check("Vercel with GEMINI_FILES=0: off", probe("plan", { ...GROQ, VERCEL: "1", GEMINI_FILES: "0" }).geminiFiles === false);
check("Mac with GEMINI_FILES=1: on", probe("plan", { ...LOCAL, GEMINI_FILES: "1" }).geminiFiles === true);

console.log("\n4. What the attach button says");
const say = (env) => probe("plan", env).filesGoTo;
check("Mac with Ollama: stays here", same(say(LOCAL), []), JSON.stringify(say(LOCAL)));
check("Live app: Groq and Google Gemini", same(say({ ...GROQ, VERCEL: "1" }), ["Groq", "Google Gemini"]));
check("Groq on the Mac: Groq only", same(say(GROQ), ["Groq"]));

console.log(`\n${passed}/${total} passed.`);
process.exit(passed === total ? 0 : 1);
