// All the values that were previously hardcoded constants scattered across
// agent.js/tools.js, now read from environment variables (with the exact
// same defaults as before, so nothing changes unless you actually set one).
// This is what "config-driven model swapping" means concretely: change the
// model, or even swap from local Ollama to a hosted OpenAI-compatible API,
// by editing .env - never by editing code.
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434";
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "qwen3-coder:30b";
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
// set, every request below adds `Authorization: Bearer <key>`.
export const LLM_API_KEY = process.env.LLM_API_KEY || null;

export function authHeaders() {
  return LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {};
}
