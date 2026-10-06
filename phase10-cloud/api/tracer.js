// Minimal structured tracing - the hand-rolled version of what a tool like
// Langfuse gives you: one JSON line per agent run, capturing what actually
// happened (not just the final answer) so you can debug/audit after the
// fact instead of only seeing what scrolled past in a terminal.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACE_TO } from "./config.js";

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "logs", "traces.jsonl");

// Phase 10: TRACE_TO=console prints the same line to the server log instead,
// prefixed [trace]. A hosted function's files disappear after the request;
// its console output is kept in the host's logs (Vercel: the Logs tab).
export async function logTrace(trace) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...trace });
  if (TRACE_TO === "console") {
    console.log(`[trace] ${line}`);
    return;
  }
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, line + "\n");
  } catch (err) {
    // Tracing must never break the actual request - same "nice to have
    // shouldn't take down the must have" principle as sessionStore.js.
    console.error(`[tracer] failed to write trace: ${err.message}`);
  }
}
