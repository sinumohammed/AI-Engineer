// Phase 8c: adapter between the chat server and the Phase 8b multi-agent
// supervisor. The supervisor (phase8b-multi-agent/supervisor.js) is used
// as is; this file only translates between its shape and what server.js and
// the browser already expect from the single agent (agent.js), so the server
// can call either one the same way.
import { runAgent as runSupervisor } from "../../phase8b-multi-agent/supervisor.js";
import { NUM_CTX, contextWarning } from "./agent.js";

// Same contract as agent.js's runAgent: (question, history, callbacks) ->
// { answer, usage }. The callbacks differ - a supervisor has no tool calls
// to report, it has a routing decision and specialists starting/finishing.
// `forceAgent` (optional) is the manual override: skip the router and send
// the question straight to that specialist.
export async function runMultiAgent(
  question,
  history = [],
  { onRoute, onAgentStart, onAgentDone, summary, forceAgent } = {}
) {
  const { answer, usage: totals, fromCompanyDocs } = await runSupervisor(question, history, {
    onRoute,
    onAgentStart,
    onAgentDone,
    summary,
    forceAgent,
  });

  // The UI's token ring means "how full is the context window". With one
  // model call per question that was simply the call's tokens. Here there
  // are 2-4 separate calls, each with its OWN context window, so adding them
  // up would overstate it - the honest equivalent is the largest single
  // call. The summed figures are kept alongside, as the real cost of the
  // question (`llmCalls`, `allCallsTokens`).
  const usage = {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.peakCallTokens,
    contextWindow: NUM_CTX,
    llmCalls: totals.llmCalls,
    allCallsTokens: totals.totalTokens,
  };
  usage.remainingTokens = usage.contextWindow - usage.totalTokens;
  Object.assign(usage, contextWarning(usage));

  return { answer, usage, fromCompanyDocs };
}
