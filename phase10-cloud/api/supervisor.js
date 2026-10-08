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
// The prompts, schema and validation live in routing.js, shared with the
// LangGraph version (supervisor-graph.js). This file is only the orchestration.
import { pathToFileURL } from "node:url";
import { logTrace } from "./tracer.js";
import { chat, ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { runSpecialist } from "./specialists.js";
import { standaloneQuestion, isSmallTalk } from "./retrieve.js";
import { AGENT_NAMES, ROUTE_SCHEMA, routerMessages, validateRoute, applyDocPriority, synthesizerMessages } from "./routing.js";

export async function route(question, history = []) {
  const startedAt = Date.now();
  // Phase 10: small talk goes straight to `general` - no evidence search, no
  // judge, no router call (retrieve.js, isSmallTalk).
  if (isSmallTalk(question)) {
    return {
      reason: "Greeting or thanks: answered without searching the documents.",
      tasks: [{ agent: "general", question }],
      fallback: false,
      evidence: null,
      latencyMs: Date.now() - startedAt,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  const searchQuestion = await standaloneQuestion(question, history);
  const { messages, evidence } = await routerMessages(question, history, searchQuestion);
  const res = await chat({ model: ROUTER_MODEL, label: "router", format: ROUTE_SCHEMA, messages });

  let parsed = null;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    // validateRoute falls back to a safe default
  }

  // Phase 10: a task that is the user's follow-up word for word ("And who is
  // eligible for it?") gets the resolved wording, so the specialist's own
  // document search can find what "it" is.
  const decision = applyDocPriority(validateRoute(parsed, question, history), evidence);
  if (searchQuestion !== question) {
    decision.tasks = decision.tasks.map((t) => (t.question.trim() === question.trim() ? { ...t, question: searchQuestion } : t));
  }
  return {
    ...decision,
    evidence,
    latencyMs: Date.now() - startedAt,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  };
}

// Same signature and `{ answer }` return as the single-agent runAgent, so
// phase7-reliability/eval.js can run against this unchanged via AGENT_MODULE.
//
// The optional third argument is for the chat UI (Phase 8c): progress
// callbacks so the browser can show the hand-off as it happens, and the
// session's running summary of older turns (Phase 6.11), passed on to the
// specialists. `index` identifies a step: one per task, then the synthesizer.
//
// `forceAgent` is the manual override: name a specialist and the router is
// skipped entirely - no routing call, the whole message goes to that one
// specialist as a single task. Checked first (7 probes on qwen3-coder:30b):
// a wrong pick fails safely - company_docs refuses in code, coding/general
// say they have no access to company documents - but a mixed question is no
// longer split. An unknown name is ignored and the router decides as usual.
export async function runAgent(
  question,
  history = [],
  { onRoute, onAgentStart, onAgentDone, summary, forceAgent } = {}
) {
  const startedAt = Date.now();
  // Totals across every model call, plus the largest single call: with
  // several calls per question, "how full is the context window" is about
  // the biggest one, not the sum.
  const usage = { llmCalls: 0, promptTokens: 0, completionTokens: 0, peakCallTokens: 0 };
  const count = (r, calls = 1) => {
    usage.llmCalls += calls;
    usage.promptTokens += r.promptTokens;
    usage.completionTokens += r.completionTokens;
    usage.peakCallTokens = Math.max(usage.peakCallTokens, r.promptTokens + r.completionTokens);
  };

  const manual = AGENT_NAMES.includes(forceAgent);
  let routing;
  if (manual) {
    routing = { reason: "", tasks: [{ agent: forceAgent, question }], fallback: false, evidence: null, latencyMs: 0 };
  } else {
    routing = await route(question, history);
    count(routing);
  }
  onRoute?.({ reason: routing.reason, tasks: routing.tasks, fallback: routing.fallback, manual });

  const steps = await Promise.all(
    routing.tasks.map(async (task, index) => {
      const stepStartedAt = Date.now();
      onAgentStart?.({ index, agent: task.agent, question: task.question });
      const result = await runSpecialist(task.agent, task.question, history, summary);
      count(result, result.llmCalls);
      const latencyMs = Date.now() - stepStartedAt;
      onAgentDone?.({ index, agent: task.agent, latencyMs });
      return {
        agent: task.agent,
        question: task.question,
        answer: result.answer,
        meta: result.meta,
        sources: result.sources,
        latencyMs,
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
    onAgentStart?.({ index: steps.length, agent: "synthesizer", question });
    const res = await chat({
      model: SPECIALIST_MODEL,
      label: "synthesizer",
      messages: synthesizerMessages(question, steps),
    });
    count(res);
    answer = res.content;
    synthesis = { latencyMs: Date.now() - synthStartedAt };
    onAgentDone?.({ index: steps.length, agent: "synthesizer", latencyMs: synthesis.latencyMs });
  }

  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  const trace = {
    architecture: "multi-agent",
    question,
    route: {
      reason: routing.reason,
      tasks: routing.tasks,
      fallback: routing.fallback,
      overriddenFrom: routing.overriddenFrom,
      manual,
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

  // True when the answer contains facts read from the company documents.
  // The chat server stores this with the turn, so later a specialist that
  // cannot see documents is not shown this answer (see historyFor).
  const fromCompanyDocs = steps.some((s) => s.agent === "company_docs" && s.meta.isRelevant);
  // Phase 9.6: the document excerpts the answer cited. Only company_docs
  // cites; with two company_docs tasks their numbers can overlap - rare, and
  // left as a known limitation.
  const sources = steps.flatMap((s) => s.sources ?? []);

  return { answer, usage, trace, fromCompanyDocs, sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const question = process.argv[2] ?? "What is our rollback process?";
  const { answer, trace } = await runAgent(question);
  console.log(trace.route.manual ? "route: manual" : `route (${trace.route.latencyMs}ms): ${trace.route.reason}`);
  for (const s of trace.steps) console.log(`  -> ${s.agent} (${s.latencyMs}ms): ${s.question}`);
  if (trace.synthesis) console.log(`  -> synthesizer (${trace.synthesis.latencyMs}ms)`);
  console.log(`${trace.usage.llmCalls} LLM calls, ${trace.usage.totalTokens} tokens, ${trace.latencyMs}ms total\n`);
  console.log(answer);
  process.exit(0);
}
