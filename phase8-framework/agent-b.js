// Phase 8a, Version B: "agentic RAG" - the MODEL decides whether to call
// search_company_docs, using LangChain's createAgent (LangChain v1's
// ReAct-style agent loop, replacing the older AgentExecutor). This is
// deliberately the design Phase 6.8 moved AWAY from by hand (the model
// sometimes skipped the tool and hallucinated instead of retrieving) -
// rebuilding it here checks whether the framework's loop handles that
// failure mode any better, or hits the same wall.
import { pathToFileURL } from "node:url";
import { createAgent, tool, toolCallLimitMiddleware } from "langchain";
import { z } from "zod";
import { toolImpls } from "../phase5-rag/tools.js";
import { LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE } from "../phase5-rag/config.js";
import { ChatOllama } from "@langchain/ollama";

const model = new ChatOllama({
  baseUrl: LLM_BASE_URL,
  model: CHAT_MODEL,
  temperature: TEMPERATURE,
  numCtx: NUM_CTX,
});

const searchCompanyDocs = tool(
  async ({ query }) => {
    const result = await toolImpls.search_company_docs({ query });
    // Same identifierMismatch/hybrid-search result shape as the hand-rolled
    // agent (Phase 5.6) - the tool just needs to hand it back as text for
    // the model to read, since LangChain tools return strings/JSON, not the
    // extra array properties (identifierMismatch etc) our hand-rolled loop
    // reads directly. This is itself a framework difference worth noting:
    // metadata alongside a tool result has to travel IN the result content
    // here, not as a side-channel property.
    if (Array.isArray(result) && result.identifierMismatch) {
      return "No matching document found for that specific code/ID. Do not substitute a similar one.";
    }
    return JSON.stringify(result);
  },
  {
    name: "search_company_docs",
    description:
      "Search internal company documents for information relevant to a question. Use this whenever the question could be about internal company processes, policies, or docs.",
    schema: z.object({
      query: z.string().describe("The question or topic to search company docs for."),
    }),
  }
);

// Phase 7 Bug 4 (hand-rolled agent) was an UNBOUNDED tool loop - the model
// kept calling get_current_time repeatedly with nothing left to do,
// exhausting MAX_TURNS with no final answer. toolCallLimitMiddleware is
// LangChain's built-in equivalent of our hand-rolled `MAX_TURNS` cap -
// "end" gracefully returns whatever the model has instead of erroring.
const agent = createAgent({
  model,
  tools: [searchCompanyDocs],
  prompt:
    "You are a helpful assistant. For questions that could be about internal company processes, policies, " +
    "or docs, call search_company_docs first. For general knowledge questions, answer directly without " +
    "calling any tool.",
  middleware: [toolCallLimitMiddleware({ runLimit: 5, exitBehavior: "end" })],
});

export async function runAgent(question) {
  const result = await agent.invoke({ messages: [{ role: "user", content: question }] });

  // Log every tool call the executor actually made - not just the final
  // answer. Phase 6.8's failure was SILENT (model skipped the tool, answered
  // plausibly anyway) - reading only the final text would hide exactly that
  // failure mode if it recurs here.
  const toolCallLog = [];
  for (const msg of result.messages) {
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) toolCallLog.push({ name: call.name, args: call.args });
    }
  }

  const finalMessage = result.messages.at(-1);
  return { answer: finalMessage.content, toolCallLog };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const question = process.argv[2] ?? "What is our rollback process?";
  const { answer, toolCallLog } = await runAgent(question);
  console.log("tool calls:", JSON.stringify(toolCallLog));
  console.log("answer:", answer);
  process.exit(0);
}
