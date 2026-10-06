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
// gpt-oss models think before answering; "low" | "medium" | "high". Unset
// sends nothing (the provider's default). OpenAI format only.
export const REASONING_EFFORT = process.env.REASONING_EFFORT || null;
// Phase 10 step 3: where the data lives, as connection URLs instead of
// localhost in the code. The defaults are the local Docker containers, so
// nothing changes until they are set (Neon and Upstash give URLs like these).
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
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
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
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
