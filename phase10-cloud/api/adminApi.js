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
//   GET    /api/admin/usage?days=30        Phase 10e: usage and cost per app, agent, model and app
//                                          call, latency, recent requests (usage.js) - the Command Center
//
// `npm run app` (appAdmin.js) is the command-line client.
import { timingSafeEqual, createHash } from "node:crypto";
import express from "express";
import { ADMIN_KEY, DASHBOARD_KEY } from "./config.js";
import { listApps, saveApp, refreshApp, removeApp, publicView, AppConfigError } from "./appRegistry.js";
import { appContext } from "./apps.js";
import { withAccess } from "./appAccess.js";
import { usageReport } from "./usage.js";

const digest = (s) => createHash("sha256").update(String(s)).digest();

export const adminApi = express.Router();
adminApi.use(express.json({ limit: "100kb" }));
const keyMatches = (given, key) => Boolean(given && key && timingSafeEqual(digest(given), digest(key)));
adminApi.use((req, res, next) => {
  if (!ADMIN_KEY && !DASHBOARD_KEY) return res.status(404).json({ error: "The admin API is off (no ADMIN_KEY)" });
  const given = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (keyMatches(given, ADMIN_KEY)) return next();
  // Phase 10e: the dashboard key reads usage and nothing else.
  if (req.method === "GET" && req.path === "/usage" && keyMatches(given, DASHBOARD_KEY)) return next();
  res.status(401).json({ error: req.path === "/usage" ? "Dashboard key required" : "Admin key required" });
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
adminApi.get(
  "/usage",
  handle(async (req) => {
    const days = Math.min(365, Math.max(1, Math.round(Number(req.query.days) || 30)));
    const [report, apps] = await Promise.all([usageReport(days), listApps()]);
    // The registry too, so an app with no use yet still shows (with zeros).
    return { ...report, connectedApps: apps.map((a) => ({ name: a.name, dataLevel: a.dataLevel, callers: a.callers ?? [], operations: a.operations.length })) };
  })
);
