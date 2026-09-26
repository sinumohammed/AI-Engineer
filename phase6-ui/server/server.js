// API in front of the Phase 5.5 agent, with per-session multi-turn memory
// backed by Redis (see sessionStore.js) instead of an in-process Map - this
// is what lets multiple server instances share the same conversation state.
import express from "express";
import cors from "cors";
import { runAgent } from "./agent.js";
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

  try {
    const [history, summary] = await Promise.all([getHistory(sessionId), getSummary(sessionId)]);
    const { answer, usage } = await runAgent(question, history, {
      onToolCall: (name, args) => send("tool_call", { name, args }),
      onToolResult: (name, result) => send("tool_result", { name, result }),
      summary,
    });

    await appendTurn(sessionId, question, answer);
    await saveUsage(sessionId, usage);

    const words = answer.split(" ");
    for (const word of words) {
      send("answer_chunk", { text: word + " " });
      await new Promise((r) => setTimeout(r, 40));
    }
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

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => console.log(`Phase 6 API listening on http://localhost:${PORT}`));
