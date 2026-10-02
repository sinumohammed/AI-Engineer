// Everything about routing and merging that does NOT depend on how the
// agents are orchestrated: the router's prompt and output schema, the
// document evidence it is shown, validation of its decision, and the
// synthesizer's prompt. Both supervisors import from here - the hand-rolled
// one (supervisor.js) and the LangGraph one (supervisor-graph.js) - so the
// comparison between them varies the orchestration and nothing else.
import { specialists, searchDocs } from "./specialists.js";

export const AGENT_NAMES = Object.keys(specialists);
const MAX_TASKS = 3;
// How many prior messages the router sees, so it can turn a follow-up like
// "and how do I do that in code?" into a self-contained task.
const ROUTER_HISTORY_MESSAGES = 4;
// Set ROUTER_EVIDENCE=off to route on the wording alone (the first version
// of this router) - kept switchable so the difference stays measurable.
const ROUTER_EVIDENCE = process.env.ROUTER_EVIDENCE !== "off";

// The hand-off is structured output, not native tool calling: Ollama
// constrains the reply to this schema, so the agent name is always one of
// the enum values and the JSON always parses. `reason` comes first so the
// model writes its reasoning before committing to an agent, and so the trace
// records WHY a question went where it did.
export const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agent: { type: "string", enum: AGENT_NAMES },
          question: { type: "string" },
        },
        required: ["agent", "question"],
      },
    },
  },
  required: ["reason", "tasks"],
};

export const ROUTER_PROMPT =
  "You are the router for a team of specialist agents. You do not answer questions yourself. " +
  "Decide which agent should handle the user's message.\n\n" +
  "Agents:\n" +
  AGENT_NAMES.map((name) => `- ${name}: ${specialists[name].description}`).join("\n") +
  "\n\nRules:\n" +
  "- Almost every message is ONE task for ONE agent. Create more than one task only when the message asks " +
  "clearly separate questions that need different agents.\n" +
  "- Never send the same question to two agents.\n" +
  "- Each task's question must be self-contained: keep the user's own wording, and only rewrite it when it " +
  "refers to earlier conversation (\"that\", \"it\") so it makes sense on its own.\n" +
  "- You may be shown an excerpt found in the company documents. If the excerpt directly answers a question, " +
  "send that question to company_docs even when the wording does not mention the company. If the excerpt is " +
  "only loosely related and does not answer it, ignore the excerpt.\n" +
  "- A question about this company goes to company_docs even when no excerpt answers it.";

// Found by the routing eval: "How are rollbacks done?" has no "our" in it, so
// a router that only reads the wording sent it to `coding` - yet the company
// has a doc that answers it, and the single agent (always-retrieve) got it
// right. The router knows the specialists' descriptions, not what the
// documents contain. So retrieval runs before routing and the best excerpt is
// shown to the router as evidence. The router still decides: a plain
// "distance < threshold means company_docs" rule in code was measured and
// rejected - generic coding questions like "How do I revert a commit in git?"
// (0.493) and "How do I set up a CI build with GitHub Actions?" (0.469) also
// land under the 0.5 threshold, because the doc mentions commits and CI.
async function docEvidence(question) {
  if (!ROUTER_EVIDENCE) return { text: "", meta: null };
  const { docResults, isRelevant, bestDistance } = await searchDocs(question);
  const meta = { isRelevant, bestDistance };
  if (!isRelevant) return { text: "\n\nCompany document search: nothing relevant found.", meta };
  return {
    text: `\n\nExcerpt found in the company documents:\n${docResults[0].content.slice(0, 600)}`,
    meta,
  };
}

// The messages to send to the router model, plus the evidence metadata for
// the trace.
export async function routerMessages(question, history = []) {
  const recent = history.slice(-ROUTER_HISTORY_MESSAGES);
  const evidence = await docEvidence(question);
  const userContent =
    (recent.length
      ? `Earlier conversation:\n${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\nNew message: ${question}`
      : question) + evidence.text;
  return {
    messages: [
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: userContent },
    ],
    evidence: evidence.meta,
  };
}

// The schema guarantees the shape, not the sense: still validate in code,
// and fall back to something safe rather than crash on a bad decision.
// `parsed` is the router's decoded JSON (or null/undefined if it failed to parse).
export function validateRoute(parsed, question) {
  const reason = parsed?.reason ?? "";
  let tasks = (parsed?.tasks ?? [])
    .filter((t) => AGENT_NAMES.includes(t?.agent) && typeof t.question === "string" && t.question.trim())
    .slice(0, MAX_TASKS);
  const fallback = tasks.length === 0;
  if (fallback) tasks = [{ agent: "general", question }];
  return { reason, tasks, fallback };
}

export function synthesizerMessages(question, steps) {
  return [
    {
      role: "system",
      content:
        "You combine answers from specialist agents into one reply to the user. Cover each part of the user's " +
        "message in the order they asked it. Use only what the specialists said: do not add, correct or drop " +
        "facts. If a specialist said it does not have the information, say that plainly for that part. Answer " +
        "the user directly, as one assistant: do not mention specialists, agents or that answers were combined.",
    },
    {
      role: "user",
      content:
        `User's message: ${question}\n\n` +
        steps.map((s) => `[${s.agent}] was asked: ${s.question}\n[${s.agent}] answered: ${s.answer}`).join("\n\n"),
    },
  ];
}
