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
import { AsyncLocalStorage } from "node:async_hooks";
import { withRetry } from "./retry.js";
import { LLM_FORMAT, LLM_PROVIDER, LLM_BASE_URL, CHAT_MODEL, FALLBACK_MODEL, NUM_CTX, TEMPERATURE, REASONING_EFFORT, authHeaders } from "./config.js";

export async function chat({ model = CHAT_MODEL, messages, format, tools, label = "chat", reasoningEffort = REASONING_EFFORT }) {
  const send = LLM_FORMAT === "openai" ? sendOpenAI : sendOllama;
  const call = (m) => withRetry(() => send({ model: m, messages, format, tools, label, reasoningEffort }), { label: `${LLM_PROVIDER} ${label} request` });
  let res;
  try {
    res = await call(model);
  } catch (err) {
    // Phase 10, found by the routing eval on Groq: gpt-oss sometimes writes
    // JSON that breaks the schema (it put "reason" and "tasks" inside the
    // "parts" list), and Groq rejects it with a 400 - its strict mode checks
    // the output rather than forcing it, as Ollama does. retry.js tries again
    // (the next attempt is usually valid); if every attempt fails, empty
    // content goes back, which each caller already treats as "unreadable":
    // the router falls back to a safe default, judging to "nothing relevant".
    if (err.schemaFailed) {
      console.error(`[llm] ${label}: the model's JSON did not match the schema, after retries`);
      return { content: "", toolCalls: [], promptTokens: 0, completionTokens: 0, schemaFailed: true };
    }
    if (!err.dailyLimit) throw err;
    // Phase 10: a free tier's daily quota is used up for this model. Answer
    // with FALLBACK_MODEL (its own quota) and tell the user; or, with no
    // other model left, say plainly when to try again instead of a raw 429.
    if (!FALLBACK_MODEL || model === FALLBACK_MODEL) throw limitReached(err, model);
    notice(`Answered by ${FALLBACK_MODEL}: today's free limit for ${model} is used up.`);
    try {
      res = await call(FALLBACK_MODEL);
    } catch (err2) {
      throw err2.dailyLimit ? limitReached(err2, FALLBACK_MODEL) : err2;
    }
  }
  return { ...res, content: plainText(res.content) };
}

// Notices for the person asking, collected per request without passing
// anything through the ~8 places that call chat(): the server runs each
// request inside collectNotices (server.js) and sends what was noted.
const requestNotices = new AsyncLocalStorage();
export async function collectNotices(fn) {
  const notices = [];
  const result = await requestNotices.run(notices, fn);
  return { result, notices };
}
function notice(text) {
  const notices = requestNotices.getStore();
  if (notices && !notices.includes(text)) notices.push(text);
}

// Names the model: "the AI model" alone told neither the user nor the logs
// which daily limit ran out (found when both evals and the app stopped at once).
function limitReached(err, model) {
  const wait = err.message.match(/try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/);
  const minutes = wait ? Math.max(1, Math.ceil((Number(wait[1] ?? 0) * 3600 + Number(wait[2] ?? 0) * 60 + Number(wait[3] ?? 0)) / 60)) : null;
  const e = new Error(
    `Today's free limit for the AI model (${model}) is used up${minutes ? ` - try again in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " - try again later"}.`
  );
  e.status = 429;
  e.dailyLimit = true;
  return e;
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
    // Groq says which limit: "tokens per day (TPD)" or "requests per day (RPD)".
    if (res.status === 429 && /per day/i.test(err.message)) err.dailyLimit = true;
    if (res.status === 400 && /json_validate_failed/.test(err.message)) err.schemaFailed = true;
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
async function sendOpenAI({ model, messages, format, tools, label, reasoningEffort }) {
  const data = await post(`${LLM_BASE_URL}/chat/completions`, {
    model,
    messages,
    temperature: TEMPERATURE,
    ...(format
      ? { response_format: { type: "json_schema", json_schema: { name: label, strict: true, schema: strictSchema(format) } } }
      : {}),
    ...(tools?.length ? { tools } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
