// Phase 10e: usage metering - who uses the service, how much, and what it
// costs, per app. The base for the Command Center dashboard (adminApi.js
// GET /api/admin/usage) and, later, per-app limits and billing.
//
// One row per request in Postgres (`usage_events`, the same database as the
// handbook - Neon when hosted): which caller (the web chat, or the app whose
// key asked), which agents answered, every model call with its tokens, every
// connected-app call, the time taken and whether it worked. Never the
// question or the answer - those stay in the conversation store (Redis,
// 24 hours) and the app's own records.
//
// Collected per request without passing anything through the ~10 places that
// call a model, the same way llmClient.js collects notices: the request runs
// inside metered(), and chat() / geminiText() / the app connector report to
// whatever meter is active (AsyncLocalStorage). Outside a request - an eval
// script calling the supervisor directly - nothing is recorded.
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { DATABASE_URL } from "./config.js";
import { FREE_TIER, providerStates } from "./limits.js";

// List prices in USD per million tokens, [input, output], checked 2026-10-16:
// Groq gpt-oss (groq.com/pricing), Gemini flash-lite (ai.google.dev/pricing -
// 3.5 flash-lite assumed at 3.1 flash-lite's price; audio input costs more).
// MODEL_PRICES='{"model":[in,out]}' adds or overrides models without a code
// change. Local models (Ollama, the Mac) cost nothing and are not listed; a
// hosted model missing here is counted with cost 0 and flagged `priced: false`,
// so the dashboard can say its cost is unknown instead of showing $0 as fact.
// On Groq's free tier the real bill is $0 - these are what the same usage
// would cost on the paid tier, which is what an app would be billed.
const DEFAULT_PRICES = {
  "openai/gpt-oss-120b": [0.15, 0.6],
  "openai/gpt-oss-20b": [0.075, 0.3],
  "gemini-3.5-flash-lite": [0.25, 1.5],
  // Text in, audio tokens out; $6 per million audio tokens until 2026-12-31, then $12.
  "gemini-3.8-flash-lite-tts": [0.5, 6],
};
function loadPrices() {
  try {
    return { ...DEFAULT_PRICES, ...JSON.parse(process.env.MODEL_PRICES || "{}") };
  } catch {
    console.error("[usage] MODEL_PRICES is not valid JSON - using the defaults");
    return DEFAULT_PRICES;
  }
}
export const PRICES = loadPrices();

const meters = new AsyncLocalStorage();

// Runs fn with a fresh meter; returns { result, meter }. If fn throws, the
// error carries the meter (err.meter), so a failed request is still recorded
// with what it used before failing.
export async function metered(fn) {
  const meter = { models: [], appCalls: [], agents: [] };
  try {
    return { result: await meters.run(meter, fn), meter };
  } catch (err) {
    err.meter = meter;
    throw err;
  }
}

// One model call. provider: "groq" | "ollama" | "gemini" | ...
// costUsd: for a model not priced by tokens (Whisper: per hour of audio).
export function recordModel({ provider, model, label, promptTokens = 0, completionTokens = 0, costUsd }) {
  meters.getStore()?.models.push({ provider, model, label, promptTokens, completionTokens, costUsd });
}

// Groq Whisper, USD per hour of audio (groq.com/pricing, 2026-10-16).
export const WHISPER_PRICE_PER_HOUR = { "whisper-large-v3-turbo": 0.04, "whisper-large-v3": 0.111 };

// One call to a connected app's API (apps.js).
export function recordAppCall({ app, operation, ok, status, latencyMs }) {
  meters.getStore()?.appCalls.push({ app, operation, ok, status: status ?? null, latencyMs });
}

// A specialist that worked on the request (multiAgent.js).
export function recordAgent(agent) {
  const m = meters.getStore();
  if (m && !m.agents.includes(agent)) m.agents.push(agent);
}

const isLocal = (provider) => provider === "ollama" || provider === "local";

// Per model: calls, tokens and cost; plus the request's totals.
export function summarize(meter) {
  const byModel = new Map();
  for (const c of meter.models) {
    const row = byModel.get(c.model) ?? { model: c.model, provider: c.provider, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, priced: true };
    row.calls++;
    row.promptTokens += c.promptTokens;
    row.completionTokens += c.completionTokens;
    const price = PRICES[c.model];
    if (c.costUsd !== undefined) row.costUsd += c.costUsd;
    else if (price) row.costUsd += (c.promptTokens * price[0] + c.completionTokens * price[1]) / 1e6;
    else if (!isLocal(c.provider)) row.priced = false;
    byModel.set(c.model, row);
  }
  const models = [...byModel.values()];
  return {
    models,
    llmCalls: meter.models.length,
    promptTokens: models.reduce((s, m) => s + m.promptTokens, 0),
    completionTokens: models.reduce((s, m) => s + m.completionTokens, 0),
    costUsd: models.reduce((s, m) => s + m.costUsd, 0),
  };
}

// --- storage ---

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
db.on("error", (err) => console.error(`[usage] idle connection error: ${err.message}`));

let tableReady = null;
function ensureTable() {
  tableReady ??= db
    .query(
      `CREATE TABLE IF NOT EXISTS usage_events (
        id                bigserial PRIMARY KEY,
        at                timestamptz NOT NULL DEFAULT now(),
        caller            text NOT NULL,
        channel           text NOT NULL,
        mode              text,
        user_ref          text,
        ok                boolean NOT NULL,
        error             text,
        latency_ms        integer,
        agents            text[] NOT NULL DEFAULT '{}',
        llm_calls         integer NOT NULL DEFAULT 0,
        prompt_tokens     integer NOT NULL DEFAULT 0,
        completion_tokens integer NOT NULL DEFAULT 0,
        cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
        models            jsonb NOT NULL DEFAULT '[]',
        app_calls         jsonb NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at);
      CREATE INDEX IF NOT EXISTS usage_events_caller_at ON usage_events (caller, at);`
    )
    .catch((err) => {
      tableReady = null; // try again on the next request
      throw err;
    });
  return tableReady;
}

// Records one request. caller: "web" or the app's name. channel: "chat" (the
// web chat), "ask" (POST /api/ask), "transcribe", "attachment". Never throws:
// metering must not break the request it measures.
export async function recordUsage({ caller, channel, mode = null, userRef = null, ok, error = null, latencyMs, meter }) {
  if (!meter) return;
  const s = summarize(meter);
  const agents = meter.agents.length ? meter.agents : mode === "single" ? ["single_agent"] : [];
  try {
    await ensureTable();
    await db.query(
      `INSERT INTO usage_events (caller, channel, mode, user_ref, ok, error, latency_ms, agents, llm_calls, prompt_tokens, completion_tokens, cost_usd, models, app_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [caller, channel, mode, userRef, ok, error ? String(error).slice(0, 300) : null, latencyMs, agents, s.llmCalls, s.promptTokens, s.completionTokens, s.costUsd.toFixed(6), JSON.stringify(s.models), JSON.stringify(meter.appCalls)]
    );
  } catch (err) {
    console.error(`[usage] could not record (${caller}/${channel}): ${err.message}`);
  }
}

// A one-step job (voice to text, reading a file): run it metered and record
// it, success or failure; returns the job's result or rethrows its error.
export async function meteredJob({ caller, channel, userRef = null }, fn) {
  const startedAt = Date.now();
  try {
    const { result, meter } = await metered(fn);
    await recordUsage({ caller, channel, userRef, ok: true, latencyMs: Date.now() - startedAt, meter });
    return result;
  } catch (err) {
    await recordUsage({ caller, channel, userRef, ok: false, error: err.message, latencyMs: Date.now() - startedAt, meter: err.meter });
    throw err;
  }
}

// --- reading, for the dashboard ---

// Phase 10e: how much of each free tier is left today (limits.js). Counted
// from midnight UTC (when Gemini's daily limits reset; Groq's is rolling).
export async function freeTierToday() {
  await ensureTable();
  const [{ rows }, { rows: week }, reported] = await Promise.all([
    db.query(
      `SELECT m->>'model' AS model, m->>'provider' AS provider,
              sum((m->>'calls')::int)::int AS requests,
              sum((m->>'promptTokens')::bigint + (m->>'completionTokens')::bigint)::bigint AS tokens
         FROM usage_events, jsonb_array_elements(models) AS m
        WHERE at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        GROUP BY 1, 2`
    ),
    // The last 7 days, for the "questions left" estimate: tokens per call,
    // and calls per question (a question makes 2-4 model calls: router,
    // specialist, judge, combiner) - averages, so it does not jump about
    // early in the day.
    db.query(
      `SELECT m->>'model' AS model,
              sum((m->>'calls')::int)::int AS calls,
              sum((m->>'promptTokens')::bigint + (m->>'completionTokens')::bigint)::bigint AS tokens,
              count(DISTINCT e.id)::int AS uses
         FROM usage_events e, jsonb_array_elements(e.models) AS m
        WHERE e.at >= now() - interval '7 days'
        GROUP BY 1`
    ),
    providerStates(),
  ]);
  const avg = Object.fromEntries(
    week.map((r) => [r.model, { tokensPerCall: r.calls ? Number(r.tokens) / r.calls : null, callsPerUse: r.uses ? r.calls / r.uses : null }])
  );
  const used = Object.fromEntries(rows.map((r) => [r.model, { requests: r.requests, tokens: Number(r.tokens), provider: r.provider }]));
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  const models = [...new Set([...Object.keys(FREE_TIER), ...rows.filter((r) => r.provider !== "ollama" && r.provider !== "local").map((r) => r.model)])];
  return models.map((model) => {
    const limit = FREE_TIER[model] ?? { provider: used[model]?.provider ?? null, requestsPerDay: null, tokensPerDay: null };
    const u = used[model] ?? { requests: 0, tokens: 0 };
    const r = reported[model] ?? {};
    const exhausted = r.exhausted && new Date(r.exhausted.until) > new Date() ? r.exhausted.until : null;
    // Groq's own figure when it has given one today; else our count.
    const fromProvider = r.reported && Date.now() - Date.parse(r.reported.at) < 86400000;
    const requestsLeft = exhausted ? 0 : fromProvider ? r.reported.remainingRequests : limit.requestsPerDay != null ? Math.max(0, limit.requestsPerDay - u.requests) : null;
    // Questions left: whichever limit runs out first (requests, or tokens at
    // the average tokens per call), over the average calls per question.
    const a = avg[model] ?? {};
    const callsByTokens = limit.tokensPerDay != null && a.tokensPerCall ? Math.max(0, limit.tokensPerDay - u.tokens) / a.tokensPerCall : null;
    const callsLeft = exhausted ? 0 : [requestsLeft, callsByTokens].filter((x) => x != null).reduce((m, x) => Math.min(m, x), Infinity);
    // No history yet: a model counted in requests only (Whisper, the voice)
    // is one call per use.
    const callsPerUse = a.callsPerUse ?? (limit.tokensPerDay == null ? 1 : null);
    const usesLeft = Number.isFinite(callsLeft) && callsPerUse ? Math.floor(callsLeft / callsPerUse) : exhausted ? 0 : null;
    const limitedBy = exhausted ? "used up" : callsByTokens != null && requestsLeft != null ? (callsByTokens < requestsLeft ? "tokens" : "requests") : callsByTokens != null ? "tokens" : requestsLeft != null ? "requests" : null;
    return {
      model,
      provider: limit.provider,
      usesLeft,
      usesLeftLimitedBy: usesLeft == null ? null : limitedBy,
      basis: a.tokensPerCall || a.callsPerUse ? { tokensPerCall: a.tokensPerCall ? Math.round(a.tokensPerCall) : null, callsPerUse: a.callsPerUse ? Number(a.callsPerUse.toFixed(1)) : null, overDays: 7 } : null,
      requestsPerDay: fromProvider ? r.reported.limitRequests : limit.requestsPerDay,
      tokensPerDay: limit.tokensPerDay,
      usedToday: u,
      requestsLeft,
      requestsLeftSource: exhausted ? "provider (limit reached)" : fromProvider ? "provider" : requestsLeft != null ? "this service's count" : null,
      reportedAt: fromProvider ? r.reported.at : null,
      tokensLeft: exhausted ? 0 : limit.tokensPerDay != null ? Math.max(0, limit.tokensPerDay - u.tokens) : null,
      usedUpUntil: exhausted,
      resetsAt: exhausted ?? midnight.toISOString(),
    };
  });
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

// Everything the Command Center shows, for the last `days` days (UTC).
export async function usageReport(days = 30) {
  await ensureTable();
  const since = `now() - make_interval(days => $1)`;
  const q = (sql) => db.query(sql, [days]).then((r) => r.rows);
  const QUESTION = `channel IN ('chat', 'ask')`;
  const [byApp, byDay, byAgent, byModel, appCalls, byUser, latency, recent, failures] = await Promise.all([
    q(`SELECT caller,
              count(*) FILTER (WHERE ${QUESTION})::int AS questions,
              count(*) FILTER (WHERE NOT ok)::int AS errors,
              count(*) FILTER (WHERE channel = 'transcribe')::int AS voice,
              count(*) FILTER (WHERE channel = 'attachment')::int AS files,
              count(DISTINCT user_ref)::int AS users,
              sum(prompt_tokens)::bigint AS prompt_tokens,
              sum(completion_tokens)::bigint AS completion_tokens,
              sum(cost_usd)::float AS cost_usd,
              count(*) FILTER (WHERE at >= date_trunc('day', now()) AND ${QUESTION})::int AS questions_today,
              max(at) AS last_at
         FROM usage_events WHERE at >= ${since}
        GROUP BY caller ORDER BY questions DESC`),
    q(`SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, caller,
              count(*) FILTER (WHERE ${QUESTION})::int AS questions, sum(cost_usd)::float AS cost_usd
         FROM usage_events WHERE at >= ${since}
        GROUP BY 1, 2 ORDER BY 1`),
    q(`SELECT agent, count(*)::int AS requests
         FROM usage_events, unnest(agents) AS agent WHERE at >= ${since}
        GROUP BY agent ORDER BY requests DESC`),
    q(`SELECT m->>'model' AS model, m->>'provider' AS provider,
              sum((m->>'calls')::int)::int AS calls,
              sum((m->>'promptTokens')::bigint)::bigint AS prompt_tokens,
              sum((m->>'completionTokens')::bigint)::bigint AS completion_tokens,
              sum((m->>'costUsd')::float)::float AS cost_usd,
              bool_and((m->>'priced')::boolean) AS priced
         FROM usage_events, jsonb_array_elements(models) AS m WHERE at >= ${since}
        GROUP BY 1, 2 ORDER BY calls DESC`),
    q(`SELECT c->>'app' AS app, c->>'operation' AS operation,
              count(*)::int AS calls,
              count(*) FILTER (WHERE NOT (c->>'ok')::boolean)::int AS failures,
              round(avg((c->>'latencyMs')::int))::int AS avg_ms
         FROM usage_events, jsonb_array_elements(app_calls) AS c WHERE at >= ${since}
        GROUP BY 1, 2 ORDER BY calls DESC LIMIT 25`),
    // Users inside apps - only apps that send user.ref (askApi.js).
    q(`SELECT caller, user_ref,
              count(*) FILTER (WHERE ${QUESTION})::int AS questions,
              count(*) FILTER (WHERE NOT ok)::int AS errors,
              sum(cost_usd)::float AS cost_usd,
              max(at) AS last_at
         FROM usage_events WHERE at >= ${since} AND user_ref IS NOT NULL
        GROUP BY 1, 2 ORDER BY questions DESC, cost_usd DESC LIMIT 20`),
    q(`SELECT latency_ms FROM usage_events WHERE at >= ${since} AND ${QUESTION} AND ok AND latency_ms IS NOT NULL ORDER BY latency_ms`),
    db
      .query(
        `SELECT at, caller, channel, mode, ok, error, latency_ms, agents, llm_calls,
                prompt_tokens + completion_tokens AS tokens, cost_usd::float AS cost_usd, app_calls
           FROM usage_events ORDER BY at DESC LIMIT 30`
      )
      .then((r) => r.rows),
    // What failed, newest first - the Errors tile's list. A failed call to a
    // connected app inside an answered question is listed too (the question
    // was answered, but without that app's data).
    q(`SELECT at, caller, channel, mode, user_ref, ok, error, latency_ms, agents,
              (SELECT coalesce(jsonb_agg(c), '[]') FROM jsonb_array_elements(app_calls) AS c WHERE NOT (c->>'ok')::boolean) AS failed_app_calls
         FROM usage_events
        WHERE at >= ${since} AND (NOT ok OR app_calls @> '[{"ok": false}]')
        ORDER BY at DESC LIMIT 50`),
  ]);
  const ms = latency.map((r) => r.latency_ms);
  const num = (v) => Number(v ?? 0);
  const apps = byApp.map((r) => ({ ...r, prompt_tokens: num(r.prompt_tokens), completion_tokens: num(r.completion_tokens), cost_usd: num(r.cost_usd) }));
  return {
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      questions: apps.reduce((s, a) => s + a.questions, 0),
      questionsToday: apps.reduce((s, a) => s + a.questions_today, 0),
      errors: apps.reduce((s, a) => s + a.errors, 0),
      tokens: apps.reduce((s, a) => s + a.prompt_tokens + a.completion_tokens, 0),
      costUsd: apps.reduce((s, a) => s + a.cost_usd, 0),
      p50Ms: percentile(ms, 50),
      p95Ms: percentile(ms, 95),
    },
    byApp: apps,
    byDay,
    byAgent,
    byModel: byModel.map((r) => ({ ...r, prompt_tokens: num(r.prompt_tokens), completion_tokens: num(r.completion_tokens), cost_usd: num(r.cost_usd) })),
    appCalls,
    byUser: byUser.map((r) => ({ ...r, cost_usd: num(r.cost_usd) })),
    failures,
    recent,
    prices: PRICES,
  };
}
