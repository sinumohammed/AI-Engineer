// Phase 8b: multi-agent orchestration, hand-rolled. A supervisor does three
// things, and each one is one of the coordination problems this phase is
// about:
//   1. ROUTE   - who decides which agent handles a question? One LLM call
//                splits the message into tasks and assigns each to a specialist.
//   2. DISPATCH - run each task on its specialist (specialists.js).
//   3. COMBINE - how do results get merged? One task: return the specialist's
//                answer untouched. Several: one more LLM call merges them.
// Every run also returns/logs a full trace (route decision, each specialist's
// input, output and timing) - the answer to "how do you debug a chain of
// agents instead of one".
import { pathToFileURL } from "node:url";
import { logTrace } from "../phase5-rag/tracer.js";
import { chat, ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { specialists, searchDocs } from "./specialists.js";

const AGENT_NAMES = Object.keys(specialists);
// Set ROUTER_EVIDENCE=off to route on the wording alone (the first version
// of this router) - kept switchable so the difference stays measurable.
const ROUTER_EVIDENCE = process.env.ROUTER_EVIDENCE !== "off";
const MAX_TASKS = 3;
// How many prior messages the router sees, so it can turn a follow-up like
// "and how do I do that in code?" into a self-contained task.
const ROUTER_HISTORY_MESSAGES = 4;

// The hand-off is structured output, not native tool calling: Ollama
// constrains the reply to this schema, so the agent name is always one of
// the enum values and the JSON always parses. `reason` comes first so the
// model writes its reasoning before committing to an agent, and so the trace
// records WHY a question went where it did.
const ROUTE_SCHEMA = {
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

const ROUTER_PROMPT =
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

export async function route(question, history = []) {
  const startedAt = Date.now();
  const recent = history.slice(-ROUTER_HISTORY_MESSAGES);
  const evidence = await docEvidence(question);
  const userContent =
    (recent.length
      ? `Earlier conversation:\n${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\nNew message: ${question}`
      : question) + evidence.text;

  const res = await chat({
    model: ROUTER_MODEL,
    label: "router",
    format: ROUTE_SCHEMA,
    messages: [
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  // The schema guarantees the shape, not the sense: still validate in code,
  // and fall back to something safe rather than crash on a bad decision.
  let reason = "";
  let tasks = [];
  try {
    const parsed = JSON.parse(res.content);
    reason = parsed.reason ?? "";
    tasks = (parsed.tasks ?? [])
      .filter((t) => AGENT_NAMES.includes(t.agent) && typeof t.question === "string" && t.question.trim())
      .slice(0, MAX_TASKS);
  } catch {
    // fall through to the fallback below
  }

  const fallback = tasks.length === 0;
  if (fallback) tasks = [{ agent: "general", question }];

  return {
    reason,
    tasks,
    fallback,
    evidence: evidence.meta,
    latencyMs: Date.now() - startedAt,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  };
}

async function synthesize(question, steps) {
  const res = await chat({
    model: SPECIALIST_MODEL,
    label: "synthesizer",
    messages: [
      {
        role: "system",
        content:
          "You combine answers from specialist agents into one reply to the user. Cover each part of the user's " +
          "message in the order they asked it. Use only what the specialists said: do not add, correct or drop " +
          "facts. If a specialist said it does not have the information, say that plainly for that part.",
      },
      {
        role: "user",
        content:
          `User's message: ${question}\n\n` +
          steps.map((s) => `[${s.agent}] was asked: ${s.question}\n[${s.agent}] answered: ${s.answer}`).join("\n\n"),
      },
    ],
  });
  return res;
}

// Same signature and `{ answer }` return as the single-agent runAgent, so
// phase7-reliability/eval.js can run against this unchanged via AGENT_MODULE.
export async function runAgent(question, history = []) {
  const startedAt = Date.now();
  const usage = { llmCalls: 0, promptTokens: 0, completionTokens: 0 };
  const count = (r, calls = 1) => {
    usage.llmCalls += calls;
    usage.promptTokens += r.promptTokens;
    usage.completionTokens += r.completionTokens;
  };

  const routing = await route(question, history);
  count(routing);

  const steps = await Promise.all(
    routing.tasks.map(async (task) => {
      const stepStartedAt = Date.now();
      const result = await specialists[task.agent].run(task.question, history);
      count(result, result.llmCalls);
      return {
        agent: task.agent,
        question: task.question,
        answer: result.answer,
        meta: result.meta,
        latencyMs: Date.now() - stepStartedAt,
      };
    })
  );

  // One task: hand the specialist's answer back untouched. An extra
  // "polish" call would cost latency and risks rewording a correct answer
  // into a wrong one - only pay for synthesis when there is something to merge.
  let answer = steps[0].answer;
  let synthesis = null;
  if (steps.length > 1) {
    const synthStartedAt = Date.now();
    const res = await synthesize(question, steps);
    count(res);
    answer = res.content;
    synthesis = { latencyMs: Date.now() - synthStartedAt };
  }

  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  const trace = {
    architecture: "multi-agent",
    question,
    route: {
      reason: routing.reason,
      tasks: routing.tasks,
      fallback: routing.fallback,
      evidence: routing.evidence,
      latencyMs: routing.latencyMs,
    },
    steps,
    synthesis,
    answer,
    usage,
    latencyMs: Date.now() - startedAt,
  };
  await logTrace(trace);

  return { answer, usage, trace };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const question = process.argv[2] ?? "What is our rollback process?";
  const { answer, trace } = await runAgent(question);
  console.log(`route (${trace.route.latencyMs}ms): ${trace.route.reason}`);
  for (const s of trace.steps) console.log(`  -> ${s.agent} (${s.latencyMs}ms): ${s.question}`);
  if (trace.synthesis) console.log(`  -> synthesizer (${trace.synthesis.latencyMs}ms)`);
  console.log(`${trace.usage.llmCalls} LLM calls, ${trace.usage.totalTokens} tokens, ${trace.latencyMs}ms total\n`);
  console.log(answer);
  process.exit(0);
}
