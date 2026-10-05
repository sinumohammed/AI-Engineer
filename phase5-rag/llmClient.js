// One plain chat call to the model, shared by everything that needs a model
// call outside an agent's tool loop: the Phase 9.4 reranker here, and the
// Phase 8b supervisor's router, specialists and synthesizer
// (phase8b-multi-agent/llm.js re-exports this).
// Phase 10 will add hosted providers here, in one place.
//
// `format` is an optional JSON schema Ollama constrains the reply to, so a
// decision comes back as JSON that always parses.
import { withRetry } from "./retry.js";
import { LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE, authHeaders } from "./config.js";

export async function chat({ model = CHAT_MODEL, messages, format, label = "chat" }) {
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
