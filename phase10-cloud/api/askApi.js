// Phase 10d: POST /api/ask - the same agent for other apps, as one JSON
// request and one JSON answer (no stream, no UI). Each app sends its own key
// (stored hashed in Redis, askKeys.js, or in APP_API_KEYS in config.js) as
// "Authorization: Bearer <key>" instead of the
// web app's access code, so a key can be given to one app and taken back
// from it without touching the others.
//
//   POST /api/ask  { "question": "...", "conversationId"?: "...", "mode"?: "single" | "multi", "agent"?: "...",
//                    "user"?: { "token"?: "...", "ref"?: "..." } }
//   -> { answer, sources, fromCompanyDocs, notices, usage, conversationId, mode }
//   DELETE /api/ask/conversations/:conversationId  - forget a conversation
//   POST /api/ask/transcribe?lang=Malayalam  (raw audio body) -> { text, language } - voice input
//       for the app's own chat screen, the same speech-to-text as the web chat (transcribe.js)
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
import { transcribe, TranscribeError } from "./transcribe.js";
import { metered, meteredJob, recordUsage } from "./usage.js";
import { appForKey, hasAskKeys } from "./askKeys.js";

const MAX_QUESTION_CHARS = 4000;
const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const USER_REF = CONVERSATION_ID;

// Compared through hashes with timingSafeEqual, as the access code is (server.js).
const digest = (s) => createHash("sha256").update(String(s)).digest();
// Which app a request comes from, or null. The keys in APP_API_KEYS are all
// compared, so the time taken does not say which app's key a guess was close
// to; then the keys stored in Redis, found by their hash (askKeys.js). With no
// keys anywhere and no access code (the Mac), the endpoint is open as "local".
async function appFor(req) {
  const given = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (given) {
    let found = null;
    for (const { name, key } of APP_API_KEYS) if (timingSafeEqual(digest(given), digest(key))) found = name;
    if (found) return found;
    const stored = await appForKey(given);
    if (stored) return stored;
  }
  return !ACCESS_CODE && !(await hasAskKeys()) ? "local" : null;
}

export const askApi = express.Router();
askApi.use(express.json({ limit: "64kb" }));
askApi.use(async (req, res, next) => {
  let appName;
  try {
    appName = await appFor(req);
  } catch (err) {
    console.error(`[ask] could not check the key: ${err.message}`);
    return res.status(503).json({ error: "Could not check the API key - please try again." });
  }
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
  // Phase 10e: user.ref - the app's own id for its user ("member-42", or a hash),
  // so the usage dashboard can show use per user inside an app. Never a name.
  const validToken = user?.token === undefined || (typeof user.token === "string" && user.token.length > 0 && user.token.length <= 4096);
  const validRef = user?.ref === undefined || (typeof user.ref === "string" && USER_REF.test(user.ref));
  if (user !== undefined && !(user && (user.token !== undefined || user.ref !== undefined) && validToken && validRef)) {
    return res.status(400).json({ error: '"user" must be { "token"?: "...", "ref"?: "..." } - a token of up to 4096 characters, a ref of 1-100 letters, digits, _ . : -' });
  }

  const asked = await countAppQuestion(req.appName);
  if (asked > APP_DAILY_LIMIT) {
    return res.status(429).json({ error: `This app's daily limit of ${APP_DAILY_LIMIT} question${APP_DAILY_LIMIT === 1 ? "" : "s"} is used up - it resets at midnight UTC.` });
  }

  const sessionId = conversationId && `app:${req.appName}:${conversationId}`;
  const askedAt = new Date().toISOString();
  const started = Date.now();
  // Phase 10e: one usage row per question, for this app (usage.js).
  const record = (ok, meter, error) => recordUsage({ caller: req.appName, channel: "ask", mode, userRef: user?.ref ?? null, ok, error, latencyMs: Date.now() - started, meter });
  try {
    const { result: reply, meter } = await metered(async () => {
      const [history, summary] = sessionId ? await Promise.all([getHistory(sessionId), getSummary(sessionId)]) : [[], null];
      const q = question.trim();
      // Notices (e.g. "answered by the fallback model") are returned with the answer.
      const { result, notices } = await withAccess({ caller: req.appName, userToken: user?.token }, () =>
        collectNotices(() => (mode === "multi" ? runMultiAgent(q, history, { summary, forceAgent: agent }) : runAgent(q, history, { summary })))
      );
      const { answer, usage, fromCompanyDocs, sources = [] } = result;
      if (sessionId) await appendTurn(sessionId, q, answer, { fromCompanyDocs, askedAt, answeredAt: new Date().toISOString() });
      return { answer, sources, fromCompanyDocs, notices, usage, conversationId: conversationId ?? null, mode };
    });
    await record(true, meter);
    console.log(`[ask] app=${req.appName} mode=${mode} ${Date.now() - started} ms${sessionId ? " (conversation)" : ""}`);
    res.json(reply);
  } catch (err) {
    await record(false, err.meter, err.message);
    console.error(`[ask] app=${req.appName} failed: ${err.message}`);
    // A used-up model quota is the model's 429 with a readable message
    // (llmClient.js); anything else is not the caller's fault.
    if (err.status === 429) return res.status(429).json({ error: err.message });
    res.status(500).json({ error: "Could not answer that question - please try again." });
  }
});

// Phase 10 #4: voice input for apps - the recording as the raw body (up to
// 4 MB, Vercel's limit is 4.5 MB), the text back. Not counted as a question:
// the text is checked by the user, then asked through POST /api/ask.
askApi.post("/transcribe", express.raw({ type: () => true, limit: "4mb" }), async (req, res) => {
  try {
    res.json(await meteredJob({ caller: req.appName, channel: "transcribe" }, () => transcribe(req.body, req.get("content-type"), req.query.lang)));
  } catch (err) {
    if (!(err instanceof TranscribeError)) console.error(`[ask] app=${req.appName} transcribe: ${err.message}`);
    res.status(err.status ?? 500).json({ error: err instanceof TranscribeError ? err.message : "Could not turn the recording into text." });
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
