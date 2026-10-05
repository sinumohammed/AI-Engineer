// The chat call every role in this phase uses (router, specialists,
// synthesizer). Since Phase 9.4 the call itself lives in
// phase5-rag/llmClient.js, shared with the retrieval reranker, so there is one
// place to change when Phase 10 adds hosted providers. Two things worth
// knowing about it:
// - No `tools` field at all. Nothing in this phase uses native tool calling:
//   the router hands off via structured output instead (see supervisor.js).
//   That means every role here also runs on a model without the tools
//   capability (e.g. gemma3:4b), which Phase 8a's Version B could not.
// - Optional `format`: a JSON schema Ollama constrains the output to. This is
//   what makes the router's decision parseable every time, instead of hoping
//   the model writes valid JSON because the prompt asked nicely.
import { CHAT_MODEL } from "../phase5-rag/config.js";
export { chat } from "../phase5-rag/llmClient.js";

// Each role can run on a different model - e.g. a small model for
// specialists that only read text they are given, a bigger one for routing.
// Both default to CHAT_MODEL, so nothing changes unless you set them.
export const ROUTER_MODEL = process.env.ROUTER_MODEL ?? CHAT_MODEL;
export const SPECIALIST_MODEL = process.env.SPECIALIST_MODEL ?? CHAT_MODEL;
