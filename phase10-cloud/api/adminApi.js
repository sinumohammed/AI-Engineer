// Phase 10 #4: managing the connected apps (appRegistry.js) - no deployment
// needed to add one. Protected by ADMIN_KEY ("Authorization: Bearer <key>"),
// separate from the chat's access code and the apps' /api/ask keys. Without
// ADMIN_KEY the whole admin API answers 404.
//
//   GET    /api/admin/apps                 the apps (tokens never shown)
//   PUT    /api/admin/apps/:name           add or replace one - body: the app's entry
//   POST   /api/admin/apps/:name/refresh   read its OpenAPI file again
//   DELETE /api/admin/apps/:name
//   POST   /api/admin/try                  { question, userToken? } - plan and fetch only, no answer:
//                                          which app calls a question makes, and what came back.
//                                          Any app, whatever its callers; a userToken is passed on
//                                          as a caller would (apps with user: "required" need one).
//   GET    /api/admin/ask-keys             the /api/ask keys (askKeys.js) - app, id, last 4 characters; never a key
//   POST   /api/admin/ask-keys             { name, key? } - a new key for an app, shown once in the answer
//                                          (key: store an existing one, e.g. moved from APP_API_KEYS)
//   DELETE /api/admin/ask-keys/:idOrName   take back one key (id) or all of an app's keys (name)
//   GET    /api/admin/usage?days=30        Phase 10e: usage and cost per app, user, agent, model and
//                                          app call, latency, recent requests (usage.js) - the Command Center
//   GET    /api/admin/usage/{summary,users,daily,recent,app-calls}, /usage/openapi.json
//                                          the same, compact, for the Command Center's agents
//                                          (registered as the connected app "usage", usageOpenapi.js)
//
// `npm run app` (appAdmin.js) is the command-line client.
import { timingSafeEqual, createHash } from "node:crypto";
import express from "express";
import { ADMIN_KEY, DASHBOARD_KEY } from "./config.js";
import { listApps, saveApp, refreshApp, removeApp, publicView, AppConfigError } from "./appRegistry.js";
import { appContext } from "./apps.js";
import { withAccess } from "./appAccess.js";
import { usageReport, freeTierToday } from "./usage.js";
import { USAGE_OPENAPI } from "./usageOpenapi.js";
import { createAskKey, listAskKeys, revokeAskKeys } from "./askKeys.js";

const digest = (s) => createHash("sha256").update(String(s)).digest();

export const adminApi = express.Router();
adminApi.use(express.json({ limit: "100kb" }));
const keyMatches = (given, key) => Boolean(given && key && timingSafeEqual(digest(given), digest(key)));
adminApi.use((req, res, next) => {
  if (!ADMIN_KEY && !DASHBOARD_KEY) return res.status(404).json({ error: "The admin API is off (no ADMIN_KEY)" });
  const given = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (keyMatches(given, ADMIN_KEY)) return next();
  // Phase 10e: the dashboard key reads usage and nothing else.
  const usagePath = req.path === "/usage" || req.path.startsWith("/usage/");
  if (req.method === "GET" && usagePath && keyMatches(given, DASHBOARD_KEY)) return next();
  res.status(401).json({ error: usagePath ? "Dashboard key required" : "Admin key required" });
});

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (!(err instanceof AppConfigError)) console.error("[admin]", err);
    res.status(err instanceof AppConfigError ? err.status : 500).json({ error: err instanceof AppConfigError ? err.message : "Server error" });
  }
};

adminApi.get("/apps", handle(async () => ({ apps: (await listApps()).map(publicView) })));
adminApi.put(
  "/apps/:name",
  handle(async (req) => {
    if (req.body?.name && req.body.name !== req.params.name) throw new AppConfigError("the name in the body differs from the URL");
    return saveApp({ ...req.body, name: req.params.name });
  })
);
adminApi.post("/apps/:name/refresh", handle((req) => refreshApp(req.params.name)));
adminApi.delete(
  "/apps/:name",
  handle(async (req) => {
    await removeApp(req.params.name);
    return { removed: req.params.name };
  })
);
adminApi.post(
  "/try",
  handle(async (req) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) throw new AppConfigError("question is required");
    const userToken = typeof req.body?.userToken === "string" && req.body.userToken ? req.body.userToken : null;
    const data = await withAccess({ admin: true, userToken }, () => appContext(question));
    return { calls: data.calls, dropped: data.dropped, excerpts: data.chunks.map((c) => c.content.slice(0, 1500)) };
  })
);
adminApi.get("/ask-keys", handle(() => listAskKeys()));
adminApi.post("/ask-keys", handle((req) => createAskKey(req.body?.name, req.body?.key)));
adminApi.delete("/ask-keys/:idOrName", handle((req) => revokeAskKeys(req.params.idOrName)));
adminApi.get(
  "/usage",
  handle(async (req) => {
    const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
    const [report, apps, freeTier] = await Promise.all([usageReport(days), listApps(), freeTierToday()]);
    // The registry too, so an app with no use yet still shows (with zeros).
    return { ...report, freeTier, connectedApps: apps.map((a) => ({ name: a.name, dataLevel: a.dataLevel, callers: a.callers ?? [], operations: a.operations.length })) };
  })
);

// Phase 10e: compact views for the agents - small enough for one excerpt each.
const daysOf = (req) => Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
const appOf = (req) => (typeof req.query.app === "string" && req.query.app ? req.query.app : null);
const usd = (v) => Number(Number(v ?? 0).toFixed(6));
adminApi.get("/usage/openapi.json", (req, res) => res.json(USAGE_OPENAPI));
adminApi.get(
  "/usage/summary",
  handle(async (req) => {
    const d = await usageReport(daysOf(req));
    return {
      periodDays: d.days,
      asOf: d.generatedAt,
      costNote: "estimated USD at paid-tier prices; real bill $0 on free tiers",
      totals: { ...d.totals, costUsd: usd(d.totals.costUsd) },
      apps: d.byApp.map((a) => ({ app: a.caller, questions: a.questions, questionsToday: a.questions_today, users: a.users, voice: a.voice, files: a.files, tokens: a.prompt_tokens + a.completion_tokens, costUsd: usd(a.cost_usd), errors: a.errors, lastUsed: a.last_at })),
      models: d.byModel.map((m) => ({ model: m.model, calls: m.calls, tokens: m.prompt_tokens + m.completion_tokens, costUsd: usd(m.cost_usd) })),
      agents: d.byAgent,
    };
  })
);
adminApi.get(
  "/usage/users",
  handle(async (req) => {
    const d = await usageReport(daysOf(req));
    const app = appOf(req);
    return { periodDays: d.days, users: d.byUser.filter((u) => !app || u.caller === app).map((u) => ({ user: u.user_ref, app: u.caller, questions: u.questions, errors: u.errors, costUsd: usd(u.cost_usd), lastUsed: u.last_at })) };
  })
);
adminApi.get(
  "/usage/daily",
  handle(async (req) => {
    const d = await usageReport(daysOf(req));
    const app = appOf(req);
    return { periodDays: d.days, days: d.byDay.filter((r) => !app || r.caller === app).map((r) => ({ day: r.day, app: r.caller, questions: r.questions, costUsd: usd(r.cost_usd) })) };
  })
);
adminApi.get(
  "/usage/recent",
  handle(async (req) => {
    const limit = Math.min(30, Math.max(1, Math.round(Number(req.query.limit) || 10)));
    const d = await usageReport(1);
    return {
      requests: d.recent.slice(0, limit).map((r) => ({ at: r.at, app: r.caller, kind: r.channel, agents: r.agents, tokens: r.tokens, costUsd: usd(r.cost_usd), ms: r.latency_ms, ok: r.ok, error: r.error ?? undefined, appCalls: (r.app_calls ?? []).map((c) => `${c.app}.${c.operation}${c.ok ? "" : " (failed)"}`) })),
    };
  })
);
adminApi.get(
  "/usage/errors",
  handle(async (req) => {
    const d = await usageReport(daysOf(req));
    const app = appOf(req);
    return {
      periodDays: d.days,
      failures: d.failures
        .filter((f) => !app || f.caller === app)
        .map((f) => ({ at: f.at, app: f.caller, kind: f.channel, user: f.user_ref ?? undefined, answered: f.ok, error: f.error ?? undefined, ms: f.latency_ms, failedAppCalls: (f.failed_app_calls ?? []).map((c) => `${c.app}.${c.operation}${c.status ? ` (${c.status})` : ""}`) })),
    };
  })
);
adminApi.get(
  "/usage/free-tier",
  handle(async () => ({ note: "Today, from midnight UTC. requestsLeft is the provider's own figure where it gives one (Groq), else this service's count against the free-tier limit; usedUpUntil means the provider refused until then.", models: await freeTierToday() }))
);
adminApi.get(
  "/usage/app-calls",
  handle(async (req) => {
    const d = await usageReport(daysOf(req));
    return { periodDays: d.days, calls: d.appCalls.map((c) => ({ app: c.app, operation: c.operation, calls: c.calls, failures: c.failures, avgMs: c.avg_ms })) };
  })
);
