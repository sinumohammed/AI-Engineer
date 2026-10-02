// Phase 8b, framework version: the same supervisor as supervisor.js, rebuilt
// with LangGraph. Deliberately reuses the SAME prompts, schema, validation
// (routing.js), specialists and retrieval (specialists.js) as the hand-rolled
// version, so the only thing being compared is the orchestration:
//   hand-rolled: plain async functions, Promise.all, local variables
//   LangGraph:   a graph of nodes that read and write one shared state object
// Model calls go through ChatOllama here (the framework's own client), not
// llm.js - same choice as Phase 8a's agent-a.js.
import { pathToFileURL } from "node:url";
import { Annotation, StateGraph, Send, START, END } from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import { logTrace } from "../phase5-rag/tracer.js";
import { LLM_BASE_URL, NUM_CTX, TEMPERATURE } from "../phase5-rag/config.js";
import { ROUTER_MODEL, SPECIALIST_MODEL } from "./llm.js";
import { specialists, specialistMessages } from "./specialists.js";
import { ROUTE_SCHEMA, routerMessages, validateRoute, synthesizerMessages } from "./routing.js";

const newModel = (model) =>
  new ChatOllama({ baseUrl: LLM_BASE_URL, model, temperature: TEMPERATURE, numCtx: NUM_CTX });

// `method: "jsonSchema"` sends the schema as Ollama's `format` - the same
// mechanism as the hand-rolled router. Stated explicitly rather than left to
// the default: the other option, "functionCalling", would turn the schema
// into a tool and break on models without the tools capability (gemma3:4b),
// which is the exact dependency this design exists to avoid.
// `includeRaw` returns the raw AIMessage next to the parsed object, which is
// the only way to still read token usage for a structured-output call.
const routerModel = newModel(ROUTER_MODEL).withStructuredOutput(ROUTE_SCHEMA, {
  method: "jsonSchema",
  includeRaw: true,
});
const specialistModel = newModel(SPECIALIST_MODEL);

const usageOf = (msg) => ({
  llmCalls: 1,
  promptTokens: msg?.usage_metadata?.input_tokens ?? 0,
  completionTokens: msg?.usage_metadata?.output_tokens ?? 0,
});

// The shared state every node reads from and writes to. A node returns only
// the keys it wants to change. Plain `Annotation()` keys are overwritten by
// the latest write. `steps` and `usage` have a REDUCER instead: when two
// specialists finish in the same step and both write `steps`, the reducer
// merges the writes rather than one overwriting the other. In the
// hand-rolled version this is what Promise.all's result array and the
// `count()` closure do.
const SupervisorState = Annotation.Root({
  question: Annotation(),
  history: Annotation(),
  route: Annotation(),
  steps: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  usage: Annotation({
    reducer: (a, b) => ({
      llmCalls: a.llmCalls + b.llmCalls,
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
    }),
    default: () => ({ llmCalls: 0, promptTokens: 0, completionTokens: 0 }),
  }),
  synthesis: Annotation(),
  answer: Annotation(),
});

async function routerNode(state) {
  const startedAt = Date.now();
  const { messages, evidence } = await routerMessages(state.question, state.history);
  const { raw, parsed } = await routerModel.invoke(messages);
  return {
    route: { ...validateRoute(parsed, state.question), evidence, latencyMs: Date.now() - startedAt },
    usage: usageOf(raw),
  };
}

// The fan-out. A conditional edge normally returns the NAME of the next
// node; returning Send objects instead starts one run of that node per task,
// in parallel, each with its own input. This replaces
// `Promise.all(tasks.map(...))`. Note the input is the Send payload, NOT the
// shared state - so anything the specialist needs (history) must be passed.
function dispatch(state) {
  return state.route.tasks.map(
    (task, index) => new Send("specialist", { task, index, history: state.history ?? [] })
  );
}

async function specialistNode({ task, index, history }) {
  const startedAt = Date.now();
  const prep = await specialists[task.agent].prepare(task.question);

  let answer = prep.answer;
  let usage = { llmCalls: 0, promptTokens: 0, completionTokens: 0 };
  if (answer === undefined) {
    const res = await specialistModel.invoke(specialistMessages(prep.systemContent, task.question, history));
    answer = res.content;
    usage = usageOf(res);
  }

  return {
    steps: [
      { index, agent: task.agent, question: task.question, answer, meta: prep.meta, latencyMs: Date.now() - startedAt },
    ],
    usage,
  };
}

// Runs once, after every specialist started by `dispatch` has finished.
// Parallel writes to `steps` are merged by the reducer; sort by `index` so
// the order is the order the router asked for, not the order they finished.
const inOrder = (steps) => [...steps].sort((a, b) => a.index - b.index);

async function combineNode(state) {
  const steps = inOrder(state.steps);
  // One task: hand the specialist's answer back untouched (see supervisor.js).
  if (steps.length === 1) return { answer: steps[0].answer, synthesis: null };

  const startedAt = Date.now();
  const res = await specialistModel.invoke(synthesizerMessages(state.question, steps));
  return { answer: res.content, synthesis: { latencyMs: Date.now() - startedAt }, usage: usageOf(res) };
}

export const graph = new StateGraph(SupervisorState)
  .addNode("router", routerNode)
  .addNode("specialist", specialistNode)
  .addNode("combine", combineNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", dispatch, ["specialist"])
  .addEdge("specialist", "combine")
  .addEdge("combine", END)
  .compile();

// Router alone, for the routing eval - same return shape as supervisor.js's route().
export async function route(question, history = []) {
  const { route: decision } = await routerNode({ question, history });
  return decision;
}

// Same signature and return shape as supervisor.js's runAgent, so both evals
// run against either supervisor unchanged.
export async function runAgent(question, history = []) {
  const startedAt = Date.now();
  const state = await graph.invoke({ question, history });

  const usage = { ...state.usage, totalTokens: state.usage.promptTokens + state.usage.completionTokens };
  const trace = {
    architecture: "multi-agent-langgraph",
    question,
    route: state.route,
    steps: inOrder(state.steps).map(({ index, ...step }) => step),
    synthesis: state.synthesis,
    answer: state.answer,
    usage,
    latencyMs: Date.now() - startedAt,
  };
  await logTrace(trace);

  return { answer: state.answer, usage, trace };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `--diagram` prints the graph as Mermaid text - a picture of the flow
  // generated from the code itself, something the hand-rolled version has no
  // equivalent of.
  if (process.argv[2] === "--diagram") {
    console.log((await graph.getGraphAsync()).drawMermaid());
    process.exit(0);
  }

  const question = process.argv[2] ?? "What is our rollback process?";
  const { answer, trace } = await runAgent(question);
  console.log(`route (${trace.route.latencyMs}ms): ${trace.route.reason}`);
  for (const s of trace.steps) console.log(`  -> ${s.agent} (${s.latencyMs}ms): ${s.question}`);
  if (trace.synthesis) console.log(`  -> synthesizer (${trace.synthesis.latencyMs}ms)`);
  console.log(`${trace.usage.llmCalls} LLM calls, ${trace.usage.totalTokens} tokens, ${trace.latencyMs}ms total\n`);
  console.log(answer);
  process.exit(0);
}
