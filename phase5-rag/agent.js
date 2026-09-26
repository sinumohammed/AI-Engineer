// Combined agent: one loop, one model, multiple tools - plus always-retrieve
// RAG (search_company_docs runs on every question, unconditionally, before
// the model sees it - see phase6-ui/server/agent.js for why this replaced
// letting the model decide whether to search).
import { toolDefs, toolImpls } from "./tools.js";
import { logTrace } from "./tracer.js";
import { withRetry } from "./retry.js";
import { LLM_BASE_URL, CHAT_MODEL, NUM_CTX, TEMPERATURE, RELEVANCE_THRESHOLD, authHeaders } from "./config.js";

// See phase6-ui/server/agent.js for why list_files/read_file/get_current_time
// are all dropped too.
const AGENT_TOOL_DEFS = toolDefs.filter(
  (t) => !["search_company_docs", "list_files", "read_file", "get_current_time"].includes(t.function.name)
);

const startedAt = Date.now();
const toolCallLog = [];

const userQuestion = process.argv[2] ?? "What is our rollback process?";

toolCallLog.push({ name: "search_company_docs", args: { query: userQuestion } });
const docResults = await toolImpls.search_company_docs({ query: userQuestion });
console.log(`--- Auto-retrieval: search_company_docs({"query":"${userQuestion}"}) ---`);

const isRelevant = Array.isArray(docResults) && docResults.some((r) => r.distance < RELEVANCE_THRESHOLD);
const bestDistance = Array.isArray(docResults) ? Math.min(...docResults.map((r) => r.distance)) : null;

const systemContent = isRelevant
  ? "You are a helpful assistant. The company document excerpt below is relevant to the user's question. " +
    "Read it carefully and answer specifically using the facts it contains. Only if it truly does not " +
    "address the question at all, say plainly that you don't know.\n\n" +
    "Company document excerpt:\n" +
    docResults.map((r) => `[${r.source}] ${r.content}`).join("\n---\n")
  : "You are a helpful assistant. Answer the user's question from your own knowledge.";

const messages = [
  { role: "system", content: systemContent },
  { role: "user", content: userQuestion },
];

async function callModel() {
  return withRetry(
    async () => {
      const res = await fetch(`${LLM_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages,
          tools: AGENT_TOOL_DEFS,
          stream: false,
          options: { temperature: TEMPERATURE, num_ctx: NUM_CTX },
        }),
      });
      if (!res.ok) {
        const err = new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { label: "Ollama chat request" }
  );
}

// Same fallback as Phase 3: smaller quantized models sometimes skip Ollama's
// <tool_call> wrapper and dump raw JSON into `content` instead of `tool_calls`.
function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function extractToolCalls(msg) {
  if (msg.tool_calls?.length) return msg.tool_calls;
  if (!msg.content) return [];

  const calls = [];
  for (const candidate of extractJsonObjects(msg.content)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.name) {
        calls.push({ function: { name: parsed.name, arguments: parsed.arguments ?? {} } });
      }
    } catch {
      // skip fragments that aren't valid standalone JSON
    }
  }
  return calls;
}

const MAX_TURNS = 5;

for (let turn = 0; turn < MAX_TURNS; turn++) {
  const data = await callModel();
  const msg = data.message;
  messages.push(msg);

  const toolCalls = extractToolCalls(msg);

  if (!toolCalls.length) {
    const totalTokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
    const usedFraction = totalTokens / NUM_CTX;
    if (usedFraction >= 0.75) {
      console.log(
        `⚠️  Context ${usedFraction >= 0.95 ? "nearly full" : "filling up"}: ${totalTokens}/${NUM_CTX} tokens used.`
      );
    }
    await logTrace({
      question: userQuestion,
      isRelevant,
      bestDistance,
      toolCalls: toolCallLog,
      answer: msg.content,
      usage: { promptTokens: data.prompt_eval_count ?? 0, completionTokens: data.eval_count ?? 0, totalTokens, contextWindow: NUM_CTX },
      latencyMs: Date.now() - startedAt,
      turns: turn + 1,
    });
    console.log("--- Final answer ---");
    console.log(msg.content);
    process.exit(0);
  }

  msg.tool_calls = toolCalls;
  msg.content = "";

  for (const call of toolCalls) {
    const name = call.function.name;
    const args = call.function.arguments;
    console.log(`--- Agent is calling tool: ${name}(${JSON.stringify(args)}) ---`);
    toolCallLog.push({ name, args });

    const impl = toolImpls[name];
    const result = impl ? await impl(args) : { error: `Unknown tool: ${name}` };

    messages.push({
      role: "tool",
      content: JSON.stringify(result),
    });
  }
}

await logTrace({
  question: userQuestion,
  isRelevant,
  bestDistance,
  toolCalls: toolCallLog,
  answer: "Stopped after max turns without a final answer.",
  usage: null,
  latencyMs: Date.now() - startedAt,
  turns: MAX_TURNS,
  hitMaxTurns: true,
});
console.log("Stopped after max turns without a final answer.");
