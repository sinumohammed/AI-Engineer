// Redis-backed session store - the actual fix for the multi-instance problem.
// Every server instance connects to the SAME Redis, so it doesn't matter
// which instance a request lands on: they're all reading/writing the same
// shared data instead of separate in-process memory.
import { createClient } from "redis";
import { summarizeTurns } from "./summarize.js";
import { REDIS_URL } from "./config.js";

const client = createClient({ url: REDIS_URL });

// The redis client emits its own 'error' events on connection problems
// (Redis down, network blip, etc). Node's default behavior for an
// EventEmitter 'error' event with NO listener attached is to throw and crash
// the whole process - verified this empirically by stopping the Redis
// container mid-request: it took down the entire Node server, not just that
// one request. Attaching a listener here is what stops that; the client's
// built-in reconnectStrategy keeps retrying in the background regardless.
client.on("error", (err) => {
  console.error(`[sessionStore] Redis connection error: ${err.message}`);
});

await client.connect();

export const MAX_TURNS_STORED = 10; // 10 user+assistant pairs = 20 messages
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h - sessions expire automatically if unused

function key(sessionId) {
  return `session:${sessionId}`;
}

function usageKey(sessionId) {
  return `session:${sessionId}:usage`;
}

function summaryKey(sessionId) {
  return `session:${sessionId}:summary`;
}

// Every exported function degrades gracefully instead of throwing up to the
// request handler: if Redis is temporarily unreachable, the CHAT still
// works (just without memory for that turn) rather than failing the whole
// request. This is a deliberate tradeoff - conversation memory is "nice to
// have," not something worth breaking the core feature over.

export async function getHistory(sessionId) {
  try {
    const raw = await client.get(key(sessionId));
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(`[sessionStore] getHistory failed, continuing with no history: ${err.message}`);
    return [];
  }
}

export async function getSummary(sessionId) {
  try {
    return (await client.get(summaryKey(sessionId))) || "";
  } catch (err) {
    console.error(`[sessionStore] getSummary failed: ${err.message}`);
    return "";
  }
}

// `fromCompanyDocs` tags an answer that contains facts read from the company
// documents. The multi-agent specialists without document access are not
// shown such answers later (phase8b-multi-agent/specialists.js, historyFor) -
// otherwise they repeat company facts second-hand from the chat history.
export async function appendTurn(sessionId, userMsg, assistantMsg, { fromCompanyDocs = false } = {}) {
  try {
    const history = await getHistory(sessionId);
    history.push(
      { role: "user", content: userMsg },
      { role: "assistant", content: assistantMsg, ...(fromCompanyDocs ? { fromCompanyDocs: true } : {}) }
    );

    const maxMessages = MAX_TURNS_STORED * 2;
    if (history.length > maxMessages) {
      // Turns falling out of the window get folded into a running summary
      // instead of just discarded - see summarize.js. This is one extra LLM
      // call, but only once the window is actually full, not every turn.
      const evicted = history.slice(0, history.length - maxMessages);
      const existingSummary = await getSummary(sessionId);
      const updatedSummary = await summarizeTurns(existingSummary, evicted);
      await client.set(summaryKey(sessionId), updatedSummary, { EX: SESSION_TTL_SECONDS });
    }

    const trimmed = history.slice(-maxMessages);
    await client.set(key(sessionId), JSON.stringify(trimmed), { EX: SESSION_TTL_SECONDS });
  } catch (err) {
    console.error(`[sessionStore] appendTurn failed, this turn won't be remembered: ${err.message}`);
  }
}

export async function saveUsage(sessionId, usage) {
  try {
    await client.set(usageKey(sessionId), JSON.stringify(usage), { EX: SESSION_TTL_SECONDS });
  } catch (err) {
    console.error(`[sessionStore] saveUsage failed: ${err.message}`);
  }
}

export async function getUsage(sessionId) {
  try {
    const raw = await client.get(usageKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`[sessionStore] getUsage failed: ${err.message}`);
    return null;
  }
}

export async function clearSession(sessionId) {
  try {
    await client.del(key(sessionId));
    await client.del(usageKey(sessionId));
    await client.del(summaryKey(sessionId));
  } catch (err) {
    console.error(`[sessionStore] clearSession failed: ${err.message}`);
  }
}
