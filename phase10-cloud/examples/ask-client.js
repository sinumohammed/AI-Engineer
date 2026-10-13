// Phase 10d: how another app calls POST /api/ask - the code to copy into that
// app's backend (never into browser code: the key would be visible to anyone).
// No dependencies; Node 18+ has fetch.
//
//   npm run ask -- "What is our rollback process?"      one question
//   npm run ask                                          a conversation: type questions, empty line to stop
//   MODE=multi npm run ask -- "..."                      the supervisor instead of the single agent
//
// Reads ASK_API_KEY from ../.env (an app's key from APP_API_KEYS on the server)
// and API_URL (default: the deployed API; http://localhost:3002 for the Mac).
import { createInterface } from "node:readline";

const API_URL = process.env.API_URL ?? "https://ai-engineer-api-jet.vercel.app";
const KEY = process.env.ASK_API_KEY;
const MODE = process.env.MODE ?? "single";

// The whole client: one POST, one JSON answer. Errors always come back as
// { error } with a status (400 bad request, 401 key, 429 limit, 500 other).
async function ask(question, conversationId) {
  const res = await fetch(`${API_URL}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ question, conversationId, mode: MODE }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${data.error}`);
  return data;
}

function show({ answer, sources, notices }) {
  for (const n of notices) console.log(`(${n})`);
  console.log(`\n${answer}\n`);
  for (const s of sources) console.log(`  [${s.n}] ${s.source}${s.section ? ` - ${s.section}` : ""}`);
  if (sources.length) console.log();
}

if (!KEY) {
  console.error("Set ASK_API_KEY in phase10-cloud/.env (an app key from APP_API_KEYS).");
  process.exit(1);
}

const question = process.argv.slice(2).join(" ").trim();
try {
  if (question) {
    // One question on its own: no conversationId, nothing is remembered.
    show(await ask(question));
  } else {
    // A conversation: the same conversationId on every question, so follow-ups
    // like "and who is eligible?" work. A real app would use one per user.
    const conversationId = `example-${Date.now()}`;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Asking ${API_URL} (${MODE}). Empty line to stop.\n`);
    // Lines are read in order, so piped input works too (rl.question drops
    // lines that arrive while an answer is still on its way).
    // Piped input closes readline at its end, with lines still to come out
    // of the loop below - prompting then would throw.
    let open = true;
    rl.on("close", () => (open = false));
    rl.setPrompt("> ");
    rl.prompt();
    for await (const line of rl) {
      const q = line.trim();
      if (!q) break;
      try {
        show(await ask(q, conversationId));
      } catch (err) {
        console.error(err.message);
      }
      if (open) rl.prompt();
    }
    rl.close();
    // Optional: forget the conversation now instead of after 24 hours.
    await fetch(`${API_URL}/api/ask/conversations/${conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${KEY}` } });
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
