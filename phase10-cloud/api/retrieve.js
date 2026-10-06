// Phase 9.4: the one retrieval step every agent uses - search, then decide
// which chunks are actually relevant.
//
// Until now "relevant" meant "best vector distance under RELEVANCE_THRESHOLD
// (0.5), or any keyword hit". That number was measured on 2 chunks (Phase 7).
// On the 4,288-chunk handbook it fails both ways: 7 of 8 off-topic questions
// ("What is the capital of France?" at 0.420) count as relevant, so the
// single agent refuses general questions it used to answer. And a distance
// cannot say whether a chunk ANSWERS the question, only that it is near it.
//
// The new step: fetch more candidates (12) than the agent will read, and let
// the model judge them - which excerpts contain information that answers the
// question, best first. That one call does two jobs:
//   - the relevance gate: an empty list means "the documents do not answer
//     this", replacing the fixed threshold
//   - reranking: the agent reads the excerpts the model ranked highest,
//     instead of the 4 nearest by distance - aimed at the paraphrased
//     questions whose answer was in the top 10 but not the top 4
// Cost: one extra model call per question.
//
// The Phase 5.6 identifier check stays in code: "XJ-9999 is not in any
// document" is a fact a substring test decides better than a model.
import { toolImpls } from "./tools.js";
import { chat } from "./llmClient.js";
import { RELEVANCE_THRESHOLD } from "./config.js";

const CANDIDATES = 12;
const KEEP = 4;
// RERANK=0 restores the Phase 7 threshold, for comparison.
export const RERANK = process.env.RERANK !== "0";

const RERANK_SCHEMA = {
  type: "object",
  properties: { relevant: { type: "array", items: { type: "integer" } } },
  required: ["relevant"],
};

const RERANK_PROMPT =
  "You judge search results for a question. Each excerpt is numbered and starts with the page and section " +
  "it came from. List the numbers of the excerpts that answer the question, or a clear part of it, best first. " +
  "Judge strictly: include an excerpt only if someone could answer the question from that excerpt alone. " +
  "Sharing words or a general topic with the question is not enough. If none of them answer it, return an " +
  "empty list - that is the right answer for a question these documents do not cover.";

async function selectRelevant(question, candidates) {
  const excerpts = candidates.map((c, i) => `[${i + 1}] ${c.content.replace(/\s+/g, " ").trim()}`).join("\n\n");
  const res = await chat({
    label: "rerank",
    format: RERANK_SCHEMA,
    messages: [
      { role: "system", content: RERANK_PROMPT },
      { role: "user", content: `Question: ${question}\n\nExcerpts:\n${excerpts}` },
    ],
  });
  let ids = [];
  try {
    ids = JSON.parse(res.content).relevant ?? [];
  } catch {
    // unparseable judgement: treat as "nothing relevant" rather than guess
  }
  const seen = new Set();
  const picked = ids
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length && !seen.has(n) && seen.add(n))
    .map((n) => candidates[n - 1]);
  return { picked, usage: { promptTokens: res.promptTokens, completionTokens: res.completionTokens } };
}

// Phase 10: the question to search with, for a message that may only make
// sense in its conversation. Search and relevance judging see one message;
// "And who is eligible for it?" names nothing, and gpt-oss-120b, judging
// strictly, kept the wrong excerpt (qwen had kept the right one by luck,
// among four loose matches). The supervisor's router already rewrites such
// messages (routing.js); this gives the single agent the same.
// Only a message with a word that can point back is rewritten - decided in
// code: asked to rewrite everything, qwen turned "What is our rollback
// process?" into "...rollback process for the 12 unpaid weeks of leave
// entitled by FMLA?", tying a new question to the old topic.
const STANDALONE_HISTORY_MESSAGES = 4;
const POINTS_BACK = /\b(it|its|that|this|these|those|they|them|their|he|she|him|her|his|there|same|above|previous)\b/i;
const STANDALONE_SCHEMA = {
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
};
const STANDALONE_PROMPT =
  "You prepare a search query. Rewrite the user's latest message as one self-contained question, using the " +
  "earlier conversation only to replace words that point back to it (\"it\", \"that\", \"they\", \"the same\") " +
  "with what they refer to. Keep the user's own wording otherwise. If the message already makes sense on its own, " +
  "return it unchanged. Never answer it.";

export async function standaloneQuestion(question, history = []) {
  const recent = history.slice(-STANDALONE_HISTORY_MESSAGES);
  if (!recent.length || !POINTS_BACK.test(question)) return question;
  const conversation = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
  const res = await chat({
    label: "standalone",
    format: STANDALONE_SCHEMA,
    messages: [
      { role: "system", content: STANDALONE_PROMPT },
      { role: "user", content: `Earlier conversation:\n${conversation}\n\nLatest message: ${question}` },
    ],
  });
  try {
    const rewritten = JSON.parse(res.content).question?.trim();
    return rewritten || question;
  } catch {
    return question; // unparseable: search with the message as written, as before
  }
}

// Returns the chunks the agent should read (at most 4) and the decision
// about them, in the shape the agents already use.
export async function retrieve(question, { rerank = RERANK } = {}) {
  const results = await toolImpls.search_company_docs({ query: question, k: rerank ? CANDIDATES : KEEP });
  if (!Array.isArray(results)) {
    return { chunks: [], isRelevant: false, identifierMismatch: false, bestDistance: null, error: results?.error };
  }

  const identifierMismatch = results.identifierMismatch === true;
  const base = { identifierMismatch, bestDistance: results.bestVectorDistance, candidates: results.length };
  if (identifierMismatch) return { ...base, chunks: [], isRelevant: false };

  if (!rerank) {
    const isRelevant = results.bestVectorDistance < RELEVANCE_THRESHOLD || results.keywordHit;
    return { ...base, chunks: results.slice(0, KEEP), isRelevant };
  }

  const { picked, usage } = await selectRelevant(question, results);
  return { ...base, chunks: picked.slice(0, KEEP), isRelevant: picked.length > 0, rerankUsage: usage };
}
