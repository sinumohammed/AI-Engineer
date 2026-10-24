// Command Center: an alert when a model this service is set to use does not exist at Groq any
// more - Groq retires models (Llama 4 Maverick went, and the first Mulkiya scans failed with
// "model_not_found"). Two signals:
// - ahead of time: Groq's list of models (GET /models, fetched at most once an hour) against
//   every model setting below;
// - from real calls: a "model not found" answer (llmClient.js -> noteMissing in limits.js),
//   shown until a later call to that model works.
// Gemini models are not checked here (no model list without more setup); their failures show
// in the usage panels as errors.
import { LLM_FORMAT, LLM_PROVIDER, LLM_BASE_URL, CHAT_MODEL, JUDGE_MODEL, FALLBACK_MODELS, TRANSCRIBE_MODEL, authHeaders } from "./config.js";
import { ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { TASK_MODEL, VISION_MODEL } from "./tasks.js";
import { providerStates } from "./limits.js";
import { redis } from "./sessionStore.js";

const LIST_KEY = process.env.MODELS_LIST_KEY || "models:groq:v1";

// Each Groq model in use: the Vercel setting that picks it, and what fails without it.
export function modelsInUse() {
  const uses = [];
  if (LLM_FORMAT === "openai") { // Groq, or any OpenAI-format provider (they list models the same way)
    uses.push(
      { model: CHAT_MODEL, setting: "CHAT_MODEL", purpose: "answers" },
      { model: JUDGE_MODEL, setting: "JUDGE_MODEL", purpose: "judging the documents found" },
      { model: ROUTER_MODEL, setting: "ROUTER_MODEL", purpose: "the multi-agent router" },
      { model: SPECIALIST_MODEL, setting: "SPECIALIST_MODEL", purpose: "the specialists" },
      ...FALLBACK_MODELS.map((model) => ({ model, setting: "FALLBACK_MODEL", purpose: "the fallback when a daily limit is used up" })),
      { model: TASK_MODEL, setting: "TASK_MODEL", purpose: "apps' text tasks (Garagentic quote drafts)" },
      { model: VISION_MODEL, setting: "VISION_MODEL", purpose: "apps' photo tasks (Garagentic Mulkiya scans)" },
    );
  }
  if (process.env.GROQ_API_KEY && LLM_PROVIDER === "groq") uses.push({ model: TRANSCRIBE_MODEL, setting: "TRANSCRIBE_MODEL", purpose: "voice input when Gemini cannot" });
  // One row per model, with every setting that uses it.
  const byModel = new Map();
  for (const u of uses) {
    const row = byModel.get(u.model) ?? { model: u.model, settings: [], purposes: [] };
    if (!row.settings.includes(u.setting)) row.settings.push(u.setting);
    if (!row.purposes.includes(u.purpose)) row.purposes.push(u.purpose);
    byModel.set(u.model, row);
  }
  return [...byModel.values()];
}

// Groq's model ids, cached an hour; null when the list cannot be had (then no guesses).
async function groqModels() {
  try {
    const cached = await redis.get(LIST_KEY);
    if (cached) return JSON.parse(cached);
  } catch { /* no cache: ask Groq */ }
  try {
    const res = await fetch(`${LLM_BASE_URL}/models`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ids = ((await res.json()).data ?? []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return null;
    await redis.set(LIST_KEY, JSON.stringify(ids), { EX: 3600 }).catch(() => {});
    return ids;
  } catch {
    return null;
  }
}

export async function modelAlerts() {
  const inUse = modelsInUse();
  if (!inUse.length) return [];
  const [list, states] = await Promise.all([groqModels(), providerStates()]);
  const alerts = [];
  for (const u of inUse) {
    const s = states[u.model] ?? {};
    const failed = s.missing && (!s.reported || s.reported.at < s.missing.at) ? s.missing.at : null;
    const unlisted = list && !list.includes(u.model);
    if (!failed && !unlisted) continue;
    alerts.push({
      model: u.model, settings: u.settings, purposes: u.purposes,
      reason: failed ? `Groq answered "model not found" (${failed.slice(0, 16).replace("T", " ")} UTC)` : "Groq no longer lists this model",
      at: failed,
    });
  }
  return alerts;
}
