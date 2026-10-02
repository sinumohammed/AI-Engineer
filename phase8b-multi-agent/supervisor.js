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
import { logTrace } from "../phase5-rag/tracer.js";
import { chat, ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { runSpecialist } from "./specialists.js";
import { ROUTE_SCHEMA, routerMessages, validateRoute, synthesizerMessages } from "./routing.js";

export async function route(question, history = []) {
  const startedAt = Date.now();
  const { messages, evidence } = await routerMessages(question, history);
  const res = await chat({ model: ROUTER_MODEL, label: "router", format: ROUTE_SCHEMA, messages });

  let parsed = null;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    // validateRoute falls back to a safe default
  }

  return {
    ...validateRoute(parsed, question),
    evidence,
    latencyMs: Date.now() - startedAt,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  };
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
      const result = await runSpecialist(task.agent, task.question, history);
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
    const res = await chat({
      model: SPECIALIST_MODEL,
      label: "synthesizer",
      messages: synthesizerMessages(question, steps),
    });
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
