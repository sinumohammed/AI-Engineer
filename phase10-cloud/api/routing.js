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
// the enum values and the JSON always parses. Field order matters, because
// the model writes them in order:
// - `parts` first: the separate questions in the message. Added after a miss
//   found in the chat UI - "How are rollbacks done, and how do I list git
//   tags?" went to company_docs alone, because its two halves are close in
//   topic. Having to list the parts before choosing agents is what makes the
//   router split them (old router 20/24 on the extended eval, this one 24/24).
// - `reason` next, so the reasoning is written before committing to an
//   agent, and the trace records WHY a question went where it did.
export const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    parts: { type: "array", items: { type: "string" } },
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
  required: ["parts", "reason", "tasks"],
};

export const ROUTER_PROMPT =
  "You are the router for a team of specialist agents. You do not answer questions yourself. " +
  "Decide which agent should handle the user's message.\n\n" +
  "Agents:\n" +
  AGENT_NAMES.map((name) => `- ${name}: ${specialists[name].description}`).join("\n") +
  "\n\nRules:\n" +
  "- First fill `parts`: the separate questions the message contains, each as its own sentence. Most messages " +
  "contain exactly one. A message that joins two different questions (\"..., and how do I ...?\") contains two. " +
  "Parts come only from the user's message - never from the excerpt or the earlier conversation.\n" +
  "- Then create exactly one task per part. Choose the agent for each part on its own, as if that part had " +
  "been asked alone - two parts of one message often need different agents.\n" +
  "- Never send the same question to two agents.\n" +
  "- How to use git, a programming language or a command-line tool is a coding question, even when the " +
  "company documents mention related words - unless the excerpt directly answers it (see the next rule).\n" +
  "- Each task's question must be self-contained: keep the user's own wording, and only rewrite it when it " +
  "refers to earlier conversation (\"that\", \"it\") so it makes sense on its own.\n" +
  "- You may be shown an excerpt found in the company documents. It may answer one part of the message and " +
  "not another: judge each part separately. If the excerpt directly answers a part, send that part to " +
  "company_docs even when the wording does not mention the company, and even when general knowledge or coding " +
  "knowledge could also answer it: the company's own documents take priority over a general answer. If the " +
  "excerpt is only loosely related to a part and does not answer it, ignore the excerpt for that part.\n" +
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
    text:
      "\n\nReference only, NOT part of the user's message - excerpt found in the company documents:\n" +
      docResults[0].content.slice(0, 600),
    meta,
  };
}

// The messages to send to the router model, plus the evidence metadata for
// the trace.
// `searchQuestion`: the message with a follow-up's "it"/"that" resolved
// (retrieve.js, standaloneQuestion) - Phase 10: the evidence for "And who is
// eligible for it?" has to be searched as "...eligible for FMLA?".
export async function routerMessages(question, history = [], searchQuestion = question) {
  const recent = history.slice(-ROUTER_HISTORY_MESSAGES);
  const evidence = await docEvidence(searchQuestion);
  // The user's message is always labelled, so the router can tell it apart
  // from the excerpt below it. Without the label, a one-question message
  // ("How do I set up a CI build with GitHub Actions?") was split in two: the
  // router read the excerpt's deployment text as a second question.
  const userContent =
    (recent.length ? `Earlier conversation:\n${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n` : "") +
    `User's message: ${question}` +
    evidence.text;
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
//
// Phase 10, found by the follow-up eval case (and already in Phase 9): for
// "And who is eligible for it?" after an FMLA question, the router made two
// parts - the earlier "How many weeks of unpaid leave does FMLA entitle me
// to?" again, and "Who is eligible for FMLA?" - against its own rule that
// parts come only from the user's message. Two parts also kept the
// document-priority rule below from applying, so `general` answered the old
// question from general knowledge. A task that only repeats an earlier user
// message is dropped here, in code.
const sameQuestion = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function validateRoute(parsed, question, history = []) {
  const reason = parsed?.reason ?? "";
  let tasks = (parsed?.tasks ?? [])
    .filter((t) => AGENT_NAMES.includes(t?.agent) && typeof t.question === "string" && t.question.trim())
    .slice(0, MAX_TASKS);
  const earlier = history.filter((m) => m.role === "user").map((m) => m.content);
  const fresh = tasks.filter((t) => sameQuestion(t.question, question) || !earlier.some((e) => sameQuestion(t.question, e)));
  const repeatsDropped = fresh.length > 0 && fresh.length < tasks.length ? tasks.length - fresh.length : 0;
  if (repeatsDropped) tasks = fresh;
  const fallback = tasks.length === 0;
  if (fallback) tasks = [{ agent: "general", question }];
  return { reason, tasks, fallback, ...(repeatsDropped ? { repeatsDropped } : {}) };
}

// Phase 9.6, found by the citation eval: "Who is eligible for FMLA?" and
// "Should git commits be cryptographically signed?" were sent to `general`
// and `coding`, which answered from general knowledge - although the
// retrieval step had judged handbook excerpts as answering them, and the
// router was shown that excerpt. A stronger instruction ("the company's own
// documents take priority") changed none of the three decisions.
// So it is decided in code: for a one-part message, if the retrieval step
// judged the documents as answering it, company_docs answers it. Messages
// with several parts keep the router's split (the evidence was retrieved for
// the whole message, so it cannot say which part it answers).
// DOC_PRIORITY=0 turns this off, to compare.
const DOC_PRIORITY = process.env.DOC_PRIORITY !== "0";

export function applyDocPriority(decision, evidence) {
  const [only] = decision.tasks;
  if (!DOC_PRIORITY || decision.tasks.length !== 1 || !evidence?.isRelevant || only.agent === "company_docs") {
    return decision;
  }
  return { ...decision, tasks: [{ ...only, agent: "company_docs" }], overriddenFrom: only.agent };
}

export function synthesizerMessages(question, steps) {
  return [
    {
      role: "system",
      content:
        "You combine answers from specialist agents into one reply to the user. Cover each part of the user's " +
        "message in the order they asked it. Use only what the specialists said: do not add, correct or drop " +
        "facts. If a specialist said it does not have the information, say that plainly for that part. Answer " +
        "the user directly, as one assistant: do not mention specialists, agents or that answers were combined. " +
        "Keep citation markers such as [1] exactly as they appear, next to the facts they belong to.",
    },
    {
      role: "user",
      content:
        `User's message: ${question}\n\n` +
        steps.map((s) => `[${s.agent}] was asked: ${s.question}\n[${s.agent}] answered: ${s.answer}`).join("\n\n"),
    },
  ];
}
