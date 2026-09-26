// Phase 8a, Version A: "classic RAG" replica of phase5-rag/agent.js, but
// built with LangChain.js's ChatOllama instead of hand-rolled fetch calls.
// Deliberately reuses the SAME retrieval logic (phase5-rag/tools.js -
// including the Phase 5.6 hybrid search + identifier-mismatch fix) and the
// SAME config (phase5-rag/config.js) as the hand-rolled agent, so the only
// variable being compared is "hand-rolled HTTP/JSON vs. LangChain" - not a
// different retrieval strategy or different model settings.
import { pathToFileURL } from "node:url";
import { ChatOllama } from "@langchain/ollama";
import { toolImpls } from "../phase5-rag/tools.js";
import { LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE, RELEVANCE_THRESHOLD } from "../phase5-rag/config.js";

const model = new ChatOllama({
  baseUrl: LLM_BASE_URL,
  model: CHAT_MODEL,
  temperature: TEMPERATURE,
  numCtx: NUM_CTX,
});

export async function runAgent(question) {
  // Always-retrieve RAG, same as phase5-rag/agent.js - no tool-choice step,
  // no AgentExecutor. This is Version A on purpose: it isolates "does
  // LangChain simplify the plain chat-completion call" from "does LangChain
  // simplify tool-calling" (that's Version B, agent-b.js).
  const docResults = await toolImpls.search_company_docs({ query: question });

  const identifierMismatch = Array.isArray(docResults) && docResults.identifierMismatch === true;
  const isRelevant =
    !identifierMismatch &&
    Array.isArray(docResults) &&
    (docResults.bestVectorDistance < RELEVANCE_THRESHOLD || docResults.keywordHit);

  let systemContent;
  if (identifierMismatch) {
    systemContent =
      "You are a helpful assistant. The user asked about a specific code or ID that does not appear in the " +
      "company documents. Say plainly that you don't have information about that specific identifier - do not " +
      "substitute or guess a similar one from the documents.";
  } else if (isRelevant) {
    systemContent =
      "You are a helpful assistant. The company document excerpt below is relevant to the user's question. " +
      "Read it carefully and answer specifically using the facts it contains. Only if it truly does not " +
      "address the question at all, say plainly that you don't know.\n\n" +
      "Company document excerpt:\n" +
      docResults.map((r) => `[${r.source}] ${r.content}`).join("\n---\n");
  } else {
    systemContent = "You are a helpful assistant. Answer the user's question from your own knowledge.";
  }

  // This is the whole point of the comparison: phase5-rag/agent.js needs a
  // hand-written fetch() + JSON body + response.ok check + res.json() to get
  // here. LangChain's .invoke() collapses all of that into one call and
  // hands back a typed AIMessage with .content already extracted.
  const response = await model.invoke([
    { role: "system", content: systemContent },
    { role: "user", content: question },
  ]);

  // Framework win worth noting: LangChain exposes BOTH a normalized
  // usage_metadata (provider-agnostic input_tokens/output_tokens) AND passes
  // Ollama's own raw prompt_eval_count/eval_count through untouched on
  // response_metadata - phase5-rag/agent.js's hand-written usage object
  // (Phase 6.7) required manually reading data.prompt_eval_count/eval_count
  // off the raw fetch response; here it's already parsed and typed.
  const usage = {
    promptTokens: response.usage_metadata?.input_tokens ?? response.response_metadata?.prompt_eval_count ?? 0,
    completionTokens: response.usage_metadata?.output_tokens ?? response.response_metadata?.eval_count ?? 0,
    contextWindow: NUM_CTX,
  };
  usage.totalTokens = usage.promptTokens + usage.completionTokens;

  return { answer: response.content, isRelevant, identifierMismatch, usage };
}

// Plain `file://${process.argv[1]}` breaks on Windows (backslashes vs. the
// forward-slash/percent-encoded form import.meta.url actually uses) -
// pathToFileURL normalizes both sides the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const question = process.argv[2] ?? "What is our rollback process?";
  const { answer } = await runAgent(question);
  console.log(answer);
  process.exit(0);
}
