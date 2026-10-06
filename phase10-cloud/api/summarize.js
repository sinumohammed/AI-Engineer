// Summarizes conversation turns that are about to fall out of the sliding
// window (see sessionStore.js), instead of just discarding them outright.
// This is the improvement flagged back in Phase 6.5/6.9: windowing alone
// makes the agent completely forget anything older than 10 turns, with no
// trace at all. A short running summary at least preserves the gist.
import { chat } from "./llmClient.js";

export async function summarizeTurns(existingSummary, evictedTurns) {
  const evictedText = evictedTurns.map((m) => `${m.role}: ${m.content}`).join("\n");

  const prompt =
    (existingSummary ? `Existing summary of earlier conversation:\n${existingSummary}\n\n` : "") +
    "New exchange to fold into the summary:\n" +
    evictedText +
    "\n\nWrite an updated, single, short summary (2-4 sentences) covering everything important " +
    "from both the existing summary and the new exchange above - names, facts, decisions, anything " +
    "a later question might need. Be concise; this is a memory aid, not a transcript.";

  try {
    // Phase 10: the shared client, so the summary runs on any provider. On
    // Ollama this now also sends num_ctx and TEMPERATURE like every other
    // call (before, it used Ollama's default context window and temperature 0).
    const res = await chat({ label: "summarize", messages: [{ role: "user", content: prompt }] });
    return res.content.trim();
  } catch (err) {
    // Summarization failing should never break the conversation - worst
    // case, fall back to keeping the old summary unchanged (still better
    // than nothing) rather than losing the whole turn's context.
    console.error(`[summarize] failed, keeping previous summary unchanged: ${err.message}`);
    return existingSummary;
  }
}
