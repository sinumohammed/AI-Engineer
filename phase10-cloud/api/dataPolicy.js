// Phase 10 #3: which documents may go to which services - decided here, in
// code, from the settings, so a wrong .env cannot quietly send a confidential
// file to a hosted service. Agreed 2026-10-14:
//
//   level         folder                          stored in          read by
//   public        phase5-rag/docs (in git)        any database       any model
//   internal      phase10-cloud/docs-internal     any database       local or Groq, never Gemini
//   confidential  phase5-rag/docs-private         this machine only  local models only
//
// Neither non-public folder is in git. Sources keep a prefix ("internal/",
// "private/") so a chunk's level is known after ingestion.
//
// Hosted services, as checked 2026-10-14: Groq does not train on API data and
// keeps no prompts by default (abuse logs up to 30 days unless Zero Data
// Retention is on - Data Controls in Groq's console). Gemini's free tier may use
// prompts to improve Google's products, and human reviewers may read them -
// so nothing non-public is embedded by Gemini, and attached files go to Gemini
// only where GEMINI_FILES allows (on by default on Vercel only).
//
// Until #3, "private documents never leave this machine" only covered where
// they were stored (ingest.js): on the Mac with LLM_PROVIDER=groq and the
// local table, private excerpts were still sent to Groq for judging and
// answering. The search now leaves them out whenever the model is not local.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_PROVIDER, LLM_BASE_URL, DATABASE_IS_LOCAL, EMBED_PROVIDER, GEMINI_API_KEY } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

// The answer model (and the judge, router and fallbacks - one provider for
// all of them) runs on this machine: Ollama, or an OpenAI-format server here.
export const MODEL_IS_LOCAL = LOCAL_HOSTS.includes(new URL(LLM_BASE_URL).hostname);
const EMBED_IS_HOSTED = EMBED_PROVIDER === "gemini";

export const LEVELS = [
  { level: "public", dir: join(HERE, "../../phase5-rag/docs"), prefix: "" },
  { level: "internal", dir: join(HERE, "../docs-internal"), prefix: "internal/" },
  { level: "confidential", dir: join(HERE, "../../phase5-rag/docs-private"), prefix: "private/" },
];

export function levelOf(source) {
  return [...LEVELS].reverse().find((l) => l.prefix && source.startsWith(l.prefix))?.level ?? "public";
}

// Which folders ingest.js may read with these settings, and why the others not.
export function ingestPlan() {
  return LEVELS.map((l) => {
    const why =
      l.level === "public" ? null
      : EMBED_IS_HOSTED ? `${EMBED_PROVIDER} is a hosted embedding provider`
      : l.level === "confidential" && !DATABASE_IS_LOCAL ? "the database is not on this machine"
      : null;
    return { ...l, allowed: !why, why };
  });
}

// Source prefixes the search must not return, because the excerpts it
// returns are sent to the model.
export const HIDDEN_PREFIXES = MODEL_IS_LOCAL ? [] : ["private/"];

// Attached files are sent to Gemini to read photos and scanned PDFs, and for
// a long file's overview. GEMINI_FILES=1 / 0 decides; unset = on on Vercel
// (the live app, where files already go to Groq and Upstash), off elsewhere.
export const GEMINI_FILES = Boolean(GEMINI_API_KEY) && (process.env.GEMINI_FILES ? process.env.GEMINI_FILES === "1" : Boolean(process.env.VERCEL));

// For the web app: where an attached file goes, so it can say so before upload
// (a long file's chunks are embedded too - by Gemini if EMBED_PROVIDER is).
export const FILES_GO_TO = [
  ...new Set(
    [!MODEL_IS_LOCAL && (LLM_PROVIDER === "groq" ? "Groq" : new URL(LLM_BASE_URL).hostname), (GEMINI_FILES || EMBED_IS_HOSTED) && "Google Gemini"].filter(Boolean)
  ),
];

export function describePolicy() {
  const plan = ingestPlan();
  return [
    `answers see ${MODEL_IS_LOCAL ? "every level (local model)" : "public and internal documents (hosted model)"}`,
    `ingest ${plan.filter((l) => l.allowed).map((l) => l.level).join(", ")}`,
    `files to Gemini ${GEMINI_FILES ? "on" : "off"}`,
  ].join("; ");
}

// Phase 10 #4: a connected app's data goes to the answer model like a
// document of its level (appRegistry.js): a confidential app only with a
// local model. Internal and public apps may use Groq (Zero Data Retention on).
export function appAllowed(app) {
  return app.dataLevel !== "confidential" || MODEL_IS_LOCAL;
}
