// Phase 10d: POST /api/ask - the same agent for other apps, as one JSON
// request and one JSON answer (no stream, no UI). Each app sends its own key
// (APP_API_KEYS in config.js) as "Authorization: Bearer <key>" instead of the
// web app's access code, so a key can be given to one app and taken back
// from it without touching the others.
//
//   POST /api/ask  { "question": "...", "conversationId"?: "...", "mode"?: "single" | "multi", "agent"?: "...",
//                    "user"?: { "token": "..." } }
//   -> { answer, sources, fromCompanyDocs, notices, usage, conversationId, mode }
//   DELETE /api/ask/conversations/:conversationId  - forget a conversation
//
// Without conversationId every question stands alone. With one, earlier
// questions in it are remembered (Redis, 24 hours), like a chat in the web
// app. Conversations are stored per app ("app:<name>:<id>"), so one app can
// never read another's, or the web app's.
//
// Phase 10 #4: the asking app is the caller for connected apps - it sees
// only the apps whose entry names it in `callers` (appAccess.js). `user.token`
// is the app's own short-lived token for its logged-in user, passed on to the
// app's API (X-User-Token) so it answers as that user may see it. The app
// should use a conversationId per user ("user-42:chat-1"), so one user's
// conversation is never another's.
import { timingSafeEqual, createHash } from "node:crypto";
import express from "express";
import { runAgent } from "./agent.js";
import { runMultiAgent } from "./multiAgent.js";
import { collectNotices } from "./llmClient.js";
import { APP_API_KEYS, APP_DAILY_LIMIT, ACCESS_CODE } from "./config.js";
import { getHistory, getSummary, appendTurn, clearSession, countAppQuestion } from "./sessionStore.js";
import { withAccess } from "./appAccess.js";

const MAX_QUESTION_CHARS = 4000;
const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

// Compared through hashes with timingSafeEqual, as the access code is (server.js).
const digest = (s) => createHash("sha256").update(String(s)).digest();
// Which app a request comes from, or null. Every key is compared, so the time
// taken does not say which app's key a guess was close to. With no keys set
// and no access code (the Mac), the endpoint is open as "local".
function appFor(req) {
  if (!APP_API_KEYS.length) return ACCESS_CODE ? null : "local";
  const given = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!given) return null;
  let found = null;
  for (const { name, key } of APP_API_KEYS) if (timingSafeEqual(digest(given), digest(key))) found = name;
  return found;
}

export const askApi = express.Router();
askApi.use(express.json({ limit: "64kb" }));
askApi.use((req, res, next) => {
  const appName = appFor(req);
  if (!appName) return res.status(401).json({ error: "Missing or unknown API key - send Authorization: Bearer <key>." });
  req.appName = appName;
  next();
});

askApi.post("/", async (req, res) => {
  const { question, conversationId, mode = "single", agent, user } = req.body ?? {};
  if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: 'Missing "question" (a string).' });
  if (question.length > MAX_QUESTION_CHARS) return res.status(400).json({ error: `"question" is too long - up to ${MAX_QUESTION_CHARS} characters.` });
  if (conversationId !== undefined && (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId))) {
    return res.status(400).json({ error: '"conversationId" must be 1-100 characters: letters, digits, _ . : -' });
  }
  if (!["single", "multi"].includes(mode)) return res.status(400).json({ error: '"mode" must be "single" or "multi".' });
  if (user !== undefined && !(user && typeof user.token === "string" && user.token.length > 0 && user.token.length <= 4096)) {
    return res.status(400).json({ error: '"user" must be { "token": "..." } - a token of up to 4096 characters.' });
  }

  const asked = await countAppQuestion(req.appName);
  if (asked > APP_DAILY_LIMIT) {
    return res.status(429).json({ error: `This app's daily limit of ${APP_DAILY_LIMIT} question${APP_DAILY_LIMIT === 1 ? "" : "s"} is used up - it resets at midnight UTC.` });
  }

  const sessionId = conversationId && `app:${req.appName}:${conversationId}`;
  const askedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const [history, summary] = sessionId ? await Promise.all([getHistory(sessionId), getSummary(sessionId)]) : [[], null];
    const q = question.trim();
    // Notices (e.g. "answered by the fallback model") are returned with the answer.
    const { result, notices } = await withAccess({ caller: req.appName, userToken: user?.token }, () =>
      collectNotices(() => (mode === "multi" ? runMultiAgent(q, history, { summary, forceAgent: agent }) : runAgent(q, history, { summary })))
    );
    const { answer, usage, fromCompanyDocs, sources = [] } = result;
    if (sessionId) await appendTurn(sessionId, q, answer, { fromCompanyDocs, askedAt, answeredAt: new Date().toISOString() });
    console.log(`[ask] app=${req.appName} mode=${mode} ${Date.now() - started} ms${sessionId ? " (conversation)" : ""}`);
    res.json({ answer, sources, fromCompanyDocs, notices, usage, conversationId: conversationId ?? null, mode });
  } catch (err) {
    console.error(`[ask] app=${req.appName} failed: ${err.message}`);
    // A used-up model quota is the model's 429 with a readable message
    // (llmClient.js); anything else is not the caller's fault.
    if (err.status === 429) return res.status(429).json({ error: err.message });
    res.status(500).json({ error: "Could not answer that question - please try again." });
  }
});

askApi.delete("/conversations/:conversationId", async (req, res) => {
  if (!CONVERSATION_ID.test(req.params.conversationId)) return res.status(400).json({ error: "Invalid conversationId." });
  await clearSession(`app:${req.appName}:${req.params.conversationId}`);
  res.json({ ok: true });
});

// A body that is not JSON, or too big, gets a JSON error, not Express's HTML page.
askApi.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "The body must be JSON." });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "The body is too big." });
  next(err);
});
