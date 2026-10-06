// One plain chat call to the model, shared by every model call in the app:
// the single agent, the Phase 9.4 reranker, the Phase 8b supervisor's router,
// specialists and synthesizer (llm.js re-exports this), and the conversation
// summary. Phase 10 adds hosted providers here, in one place.
//
// Two request formats, picked by LLM_PROVIDER (config.js):
// - Ollama's /api/chat - what everything used before Phase 10.
// - OpenAI's /chat/completions - what Groq and most hosted providers speak.
// Both return the same shape, so no caller knows which one ran.
//
// `format` is an optional JSON schema the reply is constrained to, so a
// decision comes back as JSON that always parses.
// `tools` is sent only when the list is not empty.
import { withRetry } from "./retry.js";
import { LLM_FORMAT, LLM_PROVIDER, LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE, REASONING_EFFORT, authHeaders } from "./config.js";

export async function chat({ model = CHAT_MODEL, messages, format, tools, label = "chat" }) {
  const send = LLM_FORMAT === "openai" ? sendOpenAI : sendOllama;
  const res = await withRetry(() => send({ model, messages, format, tools, label }), { label: `${LLM_PROVIDER} ${label} request` });
  return { ...res, content: plainText(res.content) };
}

// Found on Groq's gpt-oss models (Phase 10 step 2): they write a narrow
// no-break space in "90 days" and "10 a.m.", a non-breaking hyphen in
// "XJ-2200", and sometimes cite as 【1】 instead of [1]. Each looks right on
// screen and breaks code that reads the text: the citation parser
// (citations.js) found no sources, and the evals' text checks failed on
// correct answers. Normalized here, once, for every caller. A no-op for
// models that write plain characters (qwen3-coder on Ollama).
function plainText(text) {
  return text
    .replace(/[\u00a0\u202f\u2007]/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/【(\d+)(?:†[^】]*)?】/g, "[$1]");
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`${LLM_PROVIDER} request failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    // Hosted providers say how long to wait when rate-limited (retry.js).
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return res.json();
}

async function sendOllama({ model, messages, format, tools }) {
  const data = await post(`${LLM_BASE_URL}/api/chat`, {
    model,
    messages,
    stream: false,
    ...(format ? { format } : {}),
    ...(tools?.length ? { tools } : {}),
    options: { temperature: TEMPERATURE, num_ctx: NUM_CTX },
  });
  return {
    content: data.message?.content ?? "",
    toolCalls: data.message?.tool_calls ?? [],
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}

// Differences from Ollama: the schema goes in `response_format` (strict, so
// the provider guarantees it), there is no num_ctx (the provider sets the
// context window), the reply is in choices[0], token counts are named
// prompt_tokens/completion_tokens, and tool-call arguments are a JSON string.
async function sendOpenAI({ model, messages, format, tools, label }) {
  const data = await post(`${LLM_BASE_URL}/chat/completions`, {
    model,
    messages,
    temperature: TEMPERATURE,
    ...(format
      ? { response_format: { type: "json_schema", json_schema: { name: label, strict: true, schema: strictSchema(format) } } }
      : {}),
    ...(tools?.length ? { tools } : {}),
    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
  });
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? "",
    toolCalls: (msg.tool_calls ?? []).map((c) => ({
      function: { name: c.function.name, arguments: parseArgs(c.function.arguments) },
    })),
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// Strict mode needs every object to list all its properties as required and
// allow no others. Our schemas already require everything; this adds
// `additionalProperties: false`, so the schemas stay written once for both formats.
function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strictSchema(v)]));
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

function parseArgs(args) {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
