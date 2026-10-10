// API in front of the Phase 5.5 agent, with per-session multi-turn memory
// backed by Redis (see sessionStore.js) instead of an in-process Map - this
// is what lets multiple server instances share the same conversation state.
import { timingSafeEqual, createHash } from "node:crypto";
import express from "express";
import cors from "cors";
import { runAgent } from "./agent.js";
import { runMultiAgent } from "./multiAgent.js";
import { collectNotices } from "./llmClient.js";
import { transcribe, TranscribeError, voiceAvailable } from "./transcribe.js";
import { LLM_PROVIDER, LLM_BASE_URL, CHAT_MODEL, JUDGE_MODEL, FALLBACK_MODELS, EMBED_PROVIDER, EMBED_MODEL, EMBED_BASE_URL, DOCS_TABLE, DATABASE_URL, REDIS_URL, TRACE_TO, ACCESS_CODE, ALLOWED_ORIGIN, describeUrl, TRANSCRIBE_MODEL, GROQ_API_KEY, GEMINI_API_KEY, GEMINI_TRANSCRIBE_MODEL } from "./config.js";
import { ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { getHistory, appendTurn, saveUsage, getUsage, getSummary, clearSession, MAX_TURNS_STORED } from "./sessionStore.js";

const app = express();
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : undefined));

// Phase 10 step 6: the access code. Sent as the x-access-code header, or as
// ?code= on the answer stream - the browser's EventSource cannot send
// headers. Compared through hashes with timingSafeEqual, so the time a check
// takes says nothing about how much of a guess was right.
const digest = (s) => createHash("sha256").update(String(s)).digest();
function hasAccess(req) {
  if (!ACCESS_CODE) return true;
  const given = req.get("x-access-code") ?? req.query.code;
  return typeof given === "string" && given.length > 0 && timingSafeEqual(digest(given), digest(ACCESS_CODE));
}
// Lets the web app ask, before opening the stream, whether a code is needed
// and whether the one it has is right - so a wrong code shows a prompt, not
// a dropped connection.
// `voice`: whether the mic button can work (transcribe.js needs a Gemini or Groq key).
app.get("/api/access", (req, res) => res.json({ required: Boolean(ACCESS_CODE), ok: hasAccess(req), voice: voiceAvailable }));
app.use("/api", (req, res, next) => (hasAccess(req) ? next() : res.status(401).json({ error: "Access code required" })));

// How many turns are stored, and whether older ones have been folded into a
// summary yet (see summarize.js) - this is what the UI shows near the token
// ring instead of duplicating the per-message token counts already shown on
// each message tile.
function memoryInfo(history, summary) {
  const turnsStored = history.length / 2;
  return {
    turnsStored,
    maxTurns: MAX_TURNS_STORED,
    turnsRemaining: Math.max(0, MAX_TURNS_STORED - turnsStored),
    hasSummary: Boolean(summary),
  };
}

// Lets the frontend restore a session's messages + last-known token usage
// on page load, instead of the visible chat resetting to empty every time
// even though Redis still has the real conversation.
app.get("/api/chat/session/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const [history, usage, summary] = await Promise.all([getHistory(sessionId), getUsage(sessionId), getSummary(sessionId)]);
  res.json({ history, usage, summary, memory: memoryInfo(history, summary) });
});

app.get("/api/chat/stream", async (req, res) => {
  const question = req.query.q;
  const sessionId = req.query.sessionId;
  if (!question || !sessionId) {
    res.status(400).json({ error: "Missing ?q= or ?sessionId= query param" });
    return;
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Phase 8c: `?mode=multi` answers with the Phase 8b supervisor instead of
  // the single agent. Chosen per request so the UI can switch between the
  // two and compare them on the same question. Anything else (including no
  // `mode` at all) keeps the single agent, so older clients behave as before.
  const mode = req.query.mode === "multi" ? "multi" : "single";

  try {
    const [history, summary] = await Promise.all([getHistory(sessionId), getSummary(sessionId)]);
    // Sessions, memory, summaries and the answer/usage/memory events below
    // are identical for both modes - only the progress events differ: the
    // single agent reports tool calls, the supervisor reports its routing
    // decision and each specialist starting and finishing.
    // Phase 10: notices (e.g. "answered by the fallback model") are collected
    // for this request by the model client and sent before the answer.
    const { result, notices } = await collectNotices(() =>
      mode === "multi"
        ? runMultiAgent(question, history, {
            onRoute: (decision) => send("route", decision),
            onAgentStart: (step) => send("agent_start", step),
            onAgentDone: (step) => send("agent_done", step),
            summary,
            // Manual override: `?agent=coding` skips the router. Absent or
            // unrecognized means the router decides (validated in supervisor.js).
            forceAgent: req.query.agent,
          })
        : runAgent(question, history, {
            onToolCall: (name, args) => send("tool_call", { name, args }),
            // `outcome` (document search only): "used", "not relevant" or
            // "code not found" - what the search led to, shown on the chip.
            onToolResult: (name, result, { outcome } = {}) => send("tool_result", { name, result, outcome }),
            summary,
          })
    );
    const { answer, usage, fromCompanyDocs, sources = [] } = result;
    for (const text of notices) send("notice", { text });

    await appendTurn(sessionId, question, answer, { fromCompanyDocs });
    await saveUsage(sessionId, usage);

    const words = answer.split(" ");
    for (const word of words) {
      send("answer_chunk", { text: word + " " });
      await new Promise((r) => setTimeout(r, 40));
    }
    // Phase 9.6: the document excerpts the answer cited, shown under it.
    if (sources.length) send("sources", sources);
    send("usage", usage);

    const [updatedHistory, updatedSummary] = await Promise.all([getHistory(sessionId), getSummary(sessionId)]);
    send("memory", memoryInfo(updatedHistory, updatedSummary));
    send("done", {});
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

app.delete("/api/chat/session/:sessionId", async (req, res) => {
  await clearSession(req.params.sessionId);
  res.json({ ok: true });
});

// Phase 10 UI: voice input - the recorded audio as the raw request body, the
// text back (transcribe.js). 4 MB is under Vercel's 4.5 MB request limit and
// far above a 2-minute recording (the web app stops there; ~1 MB of Opus).
app.post("/api/transcribe", express.raw({ type: () => true, limit: "4mb" }), async (req, res) => {
  try {
    // ?lang=Malayalam: the language the user picked, a hint for the model.
    res.json(await transcribe(req.body, req.get("content-type"), req.query.lang));
  } catch (err) {
    if (!(err instanceof TranscribeError)) console.error("[transcribe]", err);
    res.status(err.status ?? 500).json({ error: err instanceof TranscribeError ? err.message : "Could not turn the recording into text." });
  }
});
// A recording over the limit: express.raw throws before the handler runs.
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "That recording is too long - keep it under 2 minutes." });
  next(err);
});

// Phase 10 step 6: on Vercel the app is exported and Vercel runs it as one
// function; on the Mac it listens on a port as before.
export default app;

if (process.env.VERCEL) {
  logServices("Phase 10 API on Vercel");
} else {
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3002;
  app.listen(PORT, () => logServices(`Phase 10 API listening on http://localhost:${PORT}`));
}

// Which services this server is using, so a glance at the terminal (or the
// Vercel logs) answers "local or cloud?". Hosts only, never keys or passwords.
function logServices(firstLine) {
  console.log(firstLine);
  const roles =
    ROUTER_MODEL === CHAT_MODEL && SPECIALIST_MODEL === CHAT_MODEL && JUDGE_MODEL === CHAT_MODEL
      ? ""
      : ` (judging ${JUDGE_MODEL}, router ${ROUTER_MODEL}, specialists ${SPECIALIST_MODEL})`;
  const fallback = FALLBACK_MODELS.length ? `, falls back to ${FALLBACK_MODELS.join(" / ")} when a daily limit is reached` : "";
  console.log(`  chat:       ${LLM_PROVIDER} ${CHAT_MODEL}${roles} at ${describeUrl(LLM_BASE_URL)}${fallback}`);
  const embedWhere = { ollama: `at ${describeUrl(EMBED_BASE_URL)}`, local: "in this process", gemini: "at Google's Gemini API" }[EMBED_PROVIDER];
  console.log(`  embeddings: ${EMBED_PROVIDER} ${EMBED_MODEL} ${embedWhere}, table ${DOCS_TABLE}`);
  console.log(`  documents:  ${describeUrl(DATABASE_URL)}`);
  console.log(`  sessions:   ${describeUrl(REDIS_URL)}`);
  console.log(`  traces:     ${TRACE_TO === "console" ? "console" : "logs/traces.jsonl"}`);
  const voiceBy = [GEMINI_API_KEY && `Gemini ${GEMINI_TRANSCRIBE_MODEL}`, GROQ_API_KEY && `Groq ${TRANSCRIBE_MODEL}`].filter(Boolean);
  console.log(`  voice:      ${voiceBy.length ? voiceBy.join(", then ") : "off (no GEMINI_API_KEY or GROQ_API_KEY)"}`);
  console.log(`  access:     ${ACCESS_CODE ? "code required" : "open (no ACCESS_CODE)"}${ALLOWED_ORIGIN ? `, browser calls only from ${ALLOWED_ORIGIN}` : ""}`);
}
