// API in front of the Phase 5.5 agent, with per-session multi-turn memory
// backed by Redis (see sessionStore.js) instead of an in-process Map - this
// is what lets multiple server instances share the same conversation state.
import express from "express";
import cors from "cors";
import { runAgent } from "./agent.js";
import { runMultiAgent } from "./multiAgent.js";
import { LLM_PROVIDER, LLM_BASE_URL, CHAT_MODEL, EMBED_MODEL, EMBED_BASE_URL, DATABASE_URL, REDIS_URL, TRACE_TO, describeUrl } from "./config.js";
import { ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { getHistory, appendTurn, saveUsage, getUsage, getSummary, clearSession, MAX_TURNS_STORED } from "./sessionStore.js";

const app = express();
app.use(cors());

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
    const { answer, usage, fromCompanyDocs, sources = [] } =
      mode === "multi"
        ? await runMultiAgent(question, history, {
            onRoute: (decision) => send("route", decision),
            onAgentStart: (step) => send("agent_start", step),
            onAgentDone: (step) => send("agent_done", step),
            summary,
            // Manual override: `?agent=coding` skips the router. Absent or
            // unrecognized means the router decides (validated in supervisor.js).
            forceAgent: req.query.agent,
          })
        : await runAgent(question, history, {
            onToolCall: (name, args) => send("tool_call", { name, args }),
            // `outcome` (document search only): "used", "not relevant" or
            // "code not found" - what the search led to, shown on the chip.
            onToolResult: (name, result, { outcome } = {}) => send("tool_result", { name, result, outcome }),
            summary,
          });

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

const PORT = process.env.PORT ? Number(process.env.PORT) : 3002;
app.listen(PORT, () => {
  console.log(`Phase 10 API listening on http://localhost:${PORT}`);
  // Phase 10: which services this server is using, so a glance at the
  // terminal answers "local or cloud?". Hosts only, never keys or passwords.
  const roles = ROUTER_MODEL === CHAT_MODEL && SPECIALIST_MODEL === CHAT_MODEL ? "" : ` (router ${ROUTER_MODEL}, specialists ${SPECIALIST_MODEL})`;
  console.log(`  chat:       ${LLM_PROVIDER} ${CHAT_MODEL}${roles} at ${describeUrl(LLM_BASE_URL)}`);
  console.log(`  embeddings: ${EMBED_MODEL} at ${describeUrl(EMBED_BASE_URL)}`);
  console.log(`  documents:  ${describeUrl(DATABASE_URL)}`);
  console.log(`  sessions:   ${describeUrl(REDIS_URL)}`);
  console.log(`  traces:     ${TRACE_TO === "console" ? "console" : "logs/traces.jsonl"}`);
});
