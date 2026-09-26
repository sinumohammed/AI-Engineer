// Minimal structured tracing - the hand-rolled version of what a tool like
// Langfuse gives you: one JSON line per agent run, capturing what actually
// happened (not just the final answer) so you can debug/audit after the
// fact instead of only seeing what scrolled past in a terminal.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "logs", "traces.jsonl");

export async function logTrace(trace) {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...trace }) + "\n");
  } catch (err) {
    // Tracing must never break the actual request - same "nice to have
    // shouldn't take down the must have" principle as sessionStore.js.
    console.error(`[tracer] failed to write trace: ${err.message}`);
  }
}
