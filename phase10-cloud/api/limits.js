// Phase 10e: how much of each free tier is left today - for the Command
// Center's "Free tier today" panel and the agents' usage questions.
//
// Three sources, as good as each provider allows:
// - Groq reports requests left today on every response
//   (x-ratelimit-remaining-requests; its tokens headers are per minute), so
//   requests left are the provider's own figure, as of the last call;
// - every provider's "daily limit reached" error says when it resets, so a
//   used-up model shows "used up until ..." exactly;
// - otherwise this service's own count today (usage.js) against the free-tier
//   limits below - only what went through this service: evals run on the Mac
//   with the same key use the same quota but are not counted here.
// Kept in Redis (one hash), so every server instance sees the latest.
import { redis } from "./sessionStore.js";

// Free-tier limits per model, checked 2026-10-17: Groq console.groq.com/docs/
// rate-limits; Gemini's are per account and only shown in AI Studio - the TTS
// one (10 a day) is the figure its own error message gave. null = not known.
// FREE_TIER_LIMITS='{"model":{"requestsPerDay":..,"tokensPerDay":..}}' adds or overrides.
const DEFAULT_LIMITS = {
  "openai/gpt-oss-120b": { provider: "groq", requestsPerDay: 1000, tokensPerDay: 200000 },
  "openai/gpt-oss-20b": { provider: "groq", requestsPerDay: 1000, tokensPerDay: 200000 },
  "whisper-large-v3-turbo": { provider: "groq", requestsPerDay: 2000, tokensPerDay: null },
  "gemini-3.5-flash-lite": { provider: "gemini", requestsPerDay: null, tokensPerDay: null },
  "gemini-3.8-flash-lite-tts": { provider: "gemini", requestsPerDay: 10, tokensPerDay: null },
};
function loadLimits() {
  try {
    const extra = JSON.parse(process.env.FREE_TIER_LIMITS || "{}");
    return Object.fromEntries([...new Set([...Object.keys(DEFAULT_LIMITS), ...Object.keys(extra)])].map((m) => [m, { ...DEFAULT_LIMITS[m], ...extra[m] }]));
  } catch {
    console.error("[limits] FREE_TIER_LIMITS is not valid JSON - using the defaults");
    return DEFAULT_LIMITS;
  }
}
export const FREE_TIER = loadLimits();

const KEY = process.env.LIMITS_KEY || "limits:v1";
const save = (field, value) => redis.hSet(KEY, field, JSON.stringify(value)).catch((err) => console.error(`[limits] ${err.message}`));

// Groq's headers on any response (also errors): requests per day left.
export async function noteRateHeaders(model, headers) {
  const limit = headers.get?.("x-ratelimit-limit-requests");
  if (!limit) return;
  await save(`${model}:reported`, {
    limitRequests: Number(limit),
    remainingRequests: Number(headers.get("x-ratelimit-remaining-requests")),
    resetsIn: headers.get("x-ratelimit-reset-requests") ?? null,
    at: new Date().toISOString(),
  });
}

// "try again in 7m12.5s" (Groq), "retry in 21h24m" (Gemini) -> milliseconds.
export function waitFrom(message) {
  const m = String(message).match(/(?:try again|retry) in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

// A daily limit reached: used up until the time the provider gave.
export async function noteExhausted(model, message) {
  const wait = waitFrom(message);
  await save(`${model}:exhausted`, { until: new Date(Date.now() + (wait ?? 3600000)).toISOString(), exact: wait !== null, at: new Date().toISOString() });
}

// The provider said the model does not exist (Groq: 404 model_not_found) - the Command Center's
// model alert (modelCheck.js) until a later call to it works.
export async function noteMissing(model, message) {
  await save(`${model}:missing`, { at: new Date().toISOString(), message: String(message).slice(0, 300) });
}

export async function providerStates() {
  try {
    const raw = await redis.hGetAll(KEY);
    const out = {};
    for (const [field, value] of Object.entries(raw ?? {})) {
      const i = field.lastIndexOf(":");
      (out[field.slice(0, i)] ??= {})[field.slice(i + 1)] = JSON.parse(value);
    }
    return out;
  } catch (err) {
    console.error(`[limits] ${err.message}`);
    return {};
  }
}
