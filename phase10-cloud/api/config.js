// All the values that were previously hardcoded constants scattered across
// agent.js/tools.js, now read from environment variables (with the exact
// same defaults as before, so nothing changes unless you actually set one).
// This is what "config-driven model swapping" means concretely: change the
// model, or even swap from local Ollama to a hosted OpenAI-compatible API,
// by editing .env - never by editing code.
//
// Phase 10: LLM_PROVIDER picks where chat calls go and in which format.
// - "ollama" (default): Ollama's own /api/chat - everything before Phase 10.
// - "openai": any OpenAI-compatible /chat/completions API, at LLM_BASE_URL
//   with LLM_API_KEY. LLM_BASE_URL includes the version path; Ollama serves
//   one too (http://localhost:11434/v1), which tests this path locally.
// - "groq": the "openai" format with Groq's URL and GROQ_API_KEY.
// Set CHAT_MODEL to a model the provider has when switching.
const PROVIDERS = {
  ollama: { format: "ollama", baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:11434", apiKey: process.env.LLM_API_KEY },
  openai: { format: "openai", baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY },
  groq: { format: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY },
};
export const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "ollama";
const provider = PROVIDERS[LLM_PROVIDER];
if (!provider) throw new Error(`Unknown LLM_PROVIDER "${LLM_PROVIDER}" - use ollama, openai or groq`);
if (!provider.baseUrl) throw new Error(`LLM_PROVIDER=${LLM_PROVIDER} needs LLM_BASE_URL`);
export const LLM_FORMAT = provider.format;
export const LLM_BASE_URL = provider.baseUrl;
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "qwen3-coder:30b";
// Phase 10: the model for the small decisions around search - judging which
// excerpts answer the question, and rewriting a follow-up into a
// self-contained question (retrieve.js). Separate so a hosted setup can give
// them a smaller model with its own free quota (Groq limits each model to
// 200,000 tokens a day) and keep the bigger one for answers.
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? CHAT_MODEL;
// Phase 10: when a model's daily quota is used up, answer with this one
// instead of failing (llmClient.js); the UI says so. Unset = no fallback.
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL || null;
// gpt-oss models think before answering; "low" | "medium" | "high". Unset
// sends nothing (the provider's default). OpenAI format only.
export const REASONING_EFFORT = process.env.REASONING_EFFORT || null;
// Phase 10: relevance judging and follow-up rewrites are short decisions;
// "low" cut gpt-oss-20b's hidden reasoning ~80% (288 -> 61 tokens per
// question) with the same or better retrieval scores. Answers keep
// REASONING_EFFORT - low effort there is not measured.
export const JUDGE_REASONING_EFFORT = process.env.JUDGE_REASONING_EFFORT || REASONING_EFFORT;
// Phase 10 step 3: where the data lives, as connection URLs instead of
// localhost in the code. The defaults are the local Docker containers, so
// nothing changes until they are set (Neon and Upstash give URLs like these).
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
// Private documents are only ever stored in a database on this machine
// (scripts/ingest.js); the evals skip their cases elsewhere.
export const DATABASE_IS_LOCAL = ["localhost", "127.0.0.1", "::1"].includes(new URL(DATABASE_URL).hostname);
// Where traces go: "file" (logs/traces.jsonl) or "console". Hosted functions
// cannot keep files, so on Vercel (which sets VERCEL=1) the default is console.
export const TRACE_TO = process.env.TRACE_TO ?? (process.env.VERCEL ? "console" : "file");

// For startup logs: host, port and path of a connection URL, never the password.
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

// Embeddings have their own URL so chat can move to a provider without an
// embedding model (Groq has none) while search keeps working.
export const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? "http://localhost:11434";
// Phase 10 step 4: EMBED_PROVIDER picks who turns text into vectors.
// - "ollama" (default): Ollama's nomic-embed-text, at EMBED_BASE_URL.
// - "local": the same nomic model run inside this Node process (transformers.js),
//   no embedding service at all. EMBED_LOCAL_DTYPE: q8 (default, 137 MB - fits
//   a Vercel function), fp16 or fp32 (identical to Ollama's vectors, too big
//   for Vercel). The model is downloaded once, then cached.
// - "gemini": Google's Gemini API (GEMINI_API_KEY). Free tier: 100 texts a
//   minute and 1,000 a day - too few to embed the 4,284-chunk handbook in a day.
// All give 768 numbers, the size of the tables' vector column.
export const EMBED_PROVIDER = process.env.EMBED_PROVIDER ?? "ollama";
if (!["ollama", "local", "gemini"].includes(EMBED_PROVIDER)) {
  throw new Error(`Unknown EMBED_PROVIDER "${EMBED_PROVIDER}" - use ollama, local or gemini`);
}
export const EMBED_LOCAL_DTYPE = process.env.EMBED_LOCAL_DTYPE ?? "q8";
export const EMBED_MODEL = {
  ollama: process.env.EMBED_MODEL ?? "nomic-embed-text",
  local: `nomic-ai/nomic-embed-text-v1.5 ${EMBED_LOCAL_DTYPE}`,
  gemini: process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
}[EMBED_PROVIDER];
export const EMBED_DIMENSIONS = 768;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
// The chunk table search reads. Each table holds one embedding model's
// vectors; ingest.js labels it, and search refuses a table embedded with a
// different model than the one embedding the questions (embed.js).
export const DOCS_TABLE = process.env.DOCS_TABLE ?? "doc_chunks";
if (!/^[a-z_][a-z0-9_]*$/.test(DOCS_TABLE)) throw new Error(`Invalid DOCS_TABLE: ${DOCS_TABLE}`);
export const NUM_CTX = Number(process.env.NUM_CTX ?? 8192);
export const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0);
export const RELEVANCE_THRESHOLD = Number(process.env.RELEVANCE_THRESHOLD ?? 0.5);
// Phase 9.3: nomic-embed-text expects a task prefix on every input -
// "search_document: " when storing, "search_query: " when searching. Must
// match how the table being searched was ingested. On by default since 9.3;
// EMBED_PREFIX=0 only for tables ingested without it.
export const EMBED_PREFIX = process.env.EMBED_PREFIX !== "0";

// Set only when pointing at a hosted provider that requires auth (Ollama
// itself needs none - this stays unset for the default local setup). When
// set, every chat request adds `Authorization: Bearer <key>`. Embedding
// requests never send it - the key belongs to the chat provider.
export const LLM_API_KEY = provider.apiKey || null;

export function authHeaders() {
  return LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {};
}
