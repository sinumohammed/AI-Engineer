// Same agent loop as phase5-rag/agent.js, refactored to report progress via
// callbacks instead of console.log, so the HTTP server can stream events to
// the browser as they happen (tool calls are real-time; the final answer is
// chunked afterwards to simulate token streaming - see server.js).
import { toolDefs, toolImpls } from "../../phase5-rag/tools.js";
import { logTrace } from "../../phase5-rag/tracer.js";
import { withRetry } from "../../phase5-rag/retry.js";
import { LLM_BASE_URL, CHAT_MODEL, TEMPERATURE, RELEVANCE_THRESHOLD, authHeaders } from "../../phase5-rag/config.js";

// Always-retrieve RAG: search_company_docs is no longer a model-chosen tool.
// It runs unconditionally on every question (cheap - one embed call + a
// pgvector lookup), and its results are baked into the system prompt before
// the model ever sees the question. This makes "the model decided not to
// search and hallucinated instead" structurally impossible, at the cost of
// always paying the retrieval cost even for purely general questions.
// list_files/read_file/get_current_time are dropped entirely here (not just
// search_company_docs): they're Phase 3 leftovers this chat agent has no
// real use for, and each caused its own real failure mode once tried -
// read_file/list_files: the model insisting on "verifying" the
// already-injected doc excerpts by trying to read the source file, which
// always fails (wrong path) and derails the answer into a confused
// non-response. get_current_time: found via the eval suite (Phase 7) -
// once it was the ONLY tool left, the model sometimes called it repeatedly,
// in a loop, for questions with nothing to do with time (e.g. "capital of
// France"), exhausting MAX_TURNS with no final answer. No prompt wording
// fully suppressed either; removing the tools' availability is the reliable
// fix both times - same lesson as the always-retrieve change: eliminate the
// wrong option in code rather than instruct against it in the prompt.
const AGENT_TOOL_DEFS = toolDefs.filter(
  (t) => !["search_company_docs", "list_files", "read_file", "get_current_time"].includes(t.function.name)
);

const MAX_TURNS = 5;

// The model's architecture supports up to 32768 (`ollama show qwen2.5-coder:7b-instruct-q4_K_M`),
// but Ollama does NOT use that by default - without an explicit num_ctx it
// falls back to a much smaller runtime window and silently truncates old
// messages once exceeded, with no error. 8192 is a deliberate middle ground
// for this machine (16GB RAM, 4GB VRAM): comfortably fits our RAG context +
// conversation history, without the extra memory/latency cost of the full 32k.
// Now config-driven (config.js / NUM_CTX env var) rather than hardcoded -
// see config.js for what "config-driven model swapping" means concretely.
export const NUM_CTX = Number(process.env.NUM_CTX ?? 8192);

// Ollama doesn't warn when a request approaches or exceeds num_ctx - it just
// silently truncates older context with no error (verified empirically: a
// deliberately huge conversation history still "succeeded" at exactly
// promptTokens=8158/8192, no error, just older turns quietly dropped and a
// ~3x slower response). Since the model/API gives no signal of this, we
// compute our own threshold-based warning from the usage numbers we do get.
export function contextWarning(usage) {
  const usedFraction = usage.totalTokens / usage.contextWindow;
  if (usedFraction >= 0.95) {
    return {
      warningLevel: "critical",
      warningMessage:
        "Context window nearly full - older parts of this conversation may already be silently dropped. Start a new chat soon.",
    };
  }
  if (usedFraction >= 0.75) {
    return {
      warningLevel: "warning",
      warningMessage: "Approaching the context limit - older conversation history will start getting dropped soon.",
    };
  }
  return { warningLevel: null, warningMessage: null };
}

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

async function callModel(messages) {
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

// `history` is prior conversation turns: [{role:"user"|"assistant", content}, ...]
// Only canonical user/assistant turns are carried across requests - the
// tool_call/tool messages below are scratch work for THIS turn only and are
// never persisted, so a multi-turn conversation doesn't accumulate every
// past doc-search payload into the context window.
// Below this pgvector cosine distance, a chunk is treated as genuinely
// relevant. Measured empirically: real company questions ("rollback
// process", "on-call handoff") score ~0.36-0.44 against this project's doc;
// unrelated general-knowledge questions ("capital of France") score ~0.67-0.68
// - a wide, safe gap. Deciding relevance in CODE from this real number,
// instead of asking the LLM to classify "is this relevant?" in the prompt,
// is the same lesson as Phase 6.8: a small model's own judgment calls are
// unreliable (it swung between garbling an answer and over-applying "I don't
// know" to a plain general question depending on prompt wording alone) -
// a structural, numeric check doesn't have that failure mode. Now
// config-driven (config.js / RELEVANCE_THRESHOLD env var) too.

export async function runAgent(question, history = [], { onToolCall, onToolResult, summary } = {}) {
  const startedAt = Date.now();
  const toolCallLog = []; // every tool call this run made, for the trace record below

  function trackedOnToolCall(name, args) {
    toolCallLog.push({ name, args });
    onToolCall?.(name, args);
  }

  // Retrieval runs unconditionally, before the model sees the question -
  // see the AGENT_TOOL_DEFS comment above for why. Still reported through
  // the same onToolCall/onToolResult callbacks so the UI shows it happened.
  trackedOnToolCall("search_company_docs", { query: question });
  const docResults = await toolImpls.search_company_docs({ query: question });
  onToolResult?.("search_company_docs", docResults);

  // identifierMismatch (Phase 5.6): the question named a specific code/ID
  // but the exact-match keyword search (see tools.js) found no chunk
  // containing it, even though vector search alone would have called a
  // similar chunk "relevant" - a proven false-positive pattern (a made-up
  // equipment code scored nearly as close as the real one). Checked before
  // the normal relevance threshold, and kept as its own flat branch below
  // rather than nested inside another - per the Phase 7 lesson that this
  // model blends nested conditions into nonsense.
  const identifierMismatch = Array.isArray(docResults) && docResults.identifierMismatch === true;
  // Gate on vectorRows/keywordRows-derived fields, NOT on the merged/display
  // array - a keyword-only hit has no `distance` and would wrongly fail
  // `undefined < threshold` if read off `docResults` directly (see tools.js).
  const isRelevant =
    !identifierMismatch &&
    Array.isArray(docResults) &&
    (docResults.bestVectorDistance < RELEVANCE_THRESHOLD || docResults.keywordHit);
  const bestDistance = Array.isArray(docResults) ? docResults.bestVectorDistance : null;

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
    systemContent =
      "You are a helpful assistant. If the user asks about something they told you earlier in this " +
      "conversation (their name, a fact, a preference, etc), check the conversation summary and recent " +
      "messages below FIRST - that information, if present, is not private/inaccessible, it was already " +
      "shared with you directly. Only for genuinely general questions unrelated to this conversation, " +
      "answer from your own knowledge.";
  }

  const messages = [
    { role: "system", content: systemContent },
    // Turns older than the sliding window (see sessionStore.js) are folded
    // into this short running summary instead of being fully forgotten -
    // the model at least keeps the gist of anything beyond the last 10 turns.
    ...(summary ? [{ role: "system", content: `Summary of earlier conversation (before the recent messages below): ${summary}` }] : []),
    ...history,
    { role: "user", content: question },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callModel(messages);
    const msg = data.message;
    messages.push(msg);

    // prompt_eval_count = tokens Ollama had to read for this call's context
    // (system + history + tool results + question so far); eval_count = tokens
    // it generated. Their sum is the actual context-window usage for this call.
    const usage = {
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      contextWindow: NUM_CTX,
    };
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
    usage.remainingTokens = usage.contextWindow - usage.totalTokens;
    Object.assign(usage, contextWarning(usage));

    const toolCalls = extractToolCalls(msg);
    if (!toolCalls.length) {
      logTrace({
        question,
        isRelevant,
        bestDistance,
        identifierMismatch,
        toolCalls: toolCallLog,
        answer: msg.content,
        usage,
        latencyMs: Date.now() - startedAt,
        turns: turn + 1,
      });
      return { answer: msg.content, usage };
    }

    msg.tool_calls = toolCalls;
    msg.content = "";

    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments;
      trackedOnToolCall(name, args);

      const impl = toolImpls[name];
      const result = impl ? await impl(args) : { error: `Unknown tool: ${name}` };
      onToolResult?.(name, result);

      messages.push({ role: "tool", content: JSON.stringify(result) });
    }
  }

  const fallbackUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    contextWindow: NUM_CTX,
    remainingTokens: NUM_CTX,
    warningLevel: null,
    warningMessage: null,
  };
  logTrace({
    question,
    isRelevant,
    bestDistance,
    identifierMismatch,
    toolCalls: toolCallLog,
    answer: "Stopped after max turns without a final answer.",
    usage: fallbackUsage,
    latencyMs: Date.now() - startedAt,
    turns: MAX_TURNS,
    hitMaxTurns: true,
  });
  return {
    answer: "Stopped after max turns without a final answer.",
    usage: fallbackUsage,
  };
}
