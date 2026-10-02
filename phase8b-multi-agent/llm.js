// One shared chat call for every agent in this phase (router, specialists,
// synthesizer). Same fetch + withRetry shape as phase6-ui/server/agent.js's
// callModel, with two deliberate differences:
// - No `tools` field at all. Nothing in this phase uses native tool calling:
//   the router hands off via structured output instead (see supervisor.js).
//   That means every role here also runs on a model without the tools
//   capability (e.g. gemma3:4b), which Phase 8a's Version B could not.
// - Optional `format`: a JSON schema Ollama constrains the output to. This is
//   what makes the router's decision parseable every time, instead of hoping
//   the model writes valid JSON because the prompt asked nicely.
import { withRetry } from "../phase5-rag/retry.js";
import { LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE, authHeaders } from "../phase5-rag/config.js";

// Each role can run on a different model - e.g. a small model for
// specialists that only read text they are given, a bigger one for routing.
// Both default to CHAT_MODEL, so nothing changes unless you set them.
export const ROUTER_MODEL = process.env.ROUTER_MODEL ?? CHAT_MODEL;
export const SPECIALIST_MODEL = process.env.SPECIALIST_MODEL ?? CHAT_MODEL;

export async function chat({ model, messages, format, label = "chat" }) {
  const data = await withRetry(
    async () => {
      const res = await fetch(`${LLM_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          ...(format ? { format } : {}),
          options: { temperature: TEMPERATURE, num_ctx: NUM_CTX },
        }),
      });
      if (!res.ok) {
        const err = new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { label: `Ollama ${label} request` }
  );

  return {
    content: data.message?.content ?? "",
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}
