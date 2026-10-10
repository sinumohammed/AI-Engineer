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
import { RELEVANCE_THRESHOLD, JUDGE_MODEL, JUDGE_REASONING_EFFORT } from "./config.js";
import { looksNonEnglish, NON_LATIN_LETTER } from "./replyLanguage.js";

// How many search results the model judges. Phase 10: 10 instead of 12 -
// every candidate is ~90 tokens of the judging prompt on every question, and
// hosted free tiers limit tokens per day. 8 scored the same on the q8 table
// (eval/judge-cost.js, qwen3-coder and gpt-oss-20b), but on the Ollama table
// "When will I get my money back after a work trip?" has its answer at rank
// 9. 10 judges everything the retrieval eval counts as found (hit@10).
export const CANDIDATES = Number(process.env.RERANK_CANDIDATES ?? 10);
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
    model: JUDGE_MODEL,
    reasoningEffort: JUDGE_REASONING_EFFORT,
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
// The model only names what the word refers to; the code puts that name in
// place of the word. Asked to rewrite the whole sentence, qwen copied facts
// from the earlier answer ("it" -> "12 unpaid weeks of leave every 52 weeks
// under FMLA") or glued the previous question on, and even "use the short
// name" in the instruction did not stop it. The extra words moved the FMLA
// eligibility section from rank 1 to rank 9, out of the 8 judged candidates.
const STANDALONE_HISTORY_MESSAGES = 4;
export const POINTS_BACK = /\b(it|its|that|this|these|those|they|them|their|he|she|him|her|his|there|same|above|previous)\b/i;
const REFERS_TO_SCHEMA = {
  type: "object",
  properties: { refers_to: { type: "string" } },
  required: ["refers_to"],
};
const REFERS_TO_PROMPT =
  "The user's latest message contains a word that may point back to the earlier conversation (it, that, they, " +
  "this, the same...). Say what it refers to, in as few words as possible, using a name from the conversation - " +
  "for example \"FMLA\" or \"the rollback process\". If the word does not point back to the conversation, " +
  "return an empty string.";

export async function standaloneQuestion(question, history = []) {
  const recent = history.slice(-STANDALONE_HISTORY_MESSAGES);
  const word = question.match(POINTS_BACK);
  if (!recent.length || !word) return question;
  const conversation = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
  const res = await chat({
    model: JUDGE_MODEL,
    reasoningEffort: JUDGE_REASONING_EFFORT,
    label: "refers_to",
    format: REFERS_TO_SCHEMA,
    messages: [
      { role: "system", content: REFERS_TO_PROMPT },
      { role: "user", content: `Earlier conversation:\n${conversation}\n\nLatest message: ${question}\nThe word: "${word[0]}"` },
    ],
  });
  let refersTo = "";
  try {
    refersTo = JSON.parse(res.content).refers_to?.trim() ?? "";
  } catch {
    // unparseable: search with the message as written, as before
  }
  // A long answer is not a name - it is the stuffing this step exists to avoid.
  if (!refersTo || refersTo.split(/\s+/).length > 6) return question;
  return question.slice(0, word.index) + refersTo + question.slice(word.index + word[0].length);
}

// Phase 10: a message that is only a greeting, thanks or a short
// acknowledgement has nothing to search for. Before this, "hi" still ran
// the document search, the relevance judge and (multi-agent) the router -
// about 1,000-2,000 free-tier tokens to say hello. Decided in code, and
// strictly: the whole message must be small talk, so "hi, who is eligible
// for FMLA?" is searched as usual.
const SMALL_TALK =
  /^(hi|hii+|hello|hey|hey there|hi there|hello there|good (morning|afternoon|evening|night)|thanks|thank you|thank you very much|thanks a lot|many thanks|thx|ty|ok|okay|ok thanks|okay thanks|cool|great|nice|got it|bye|goodbye|see you|cheers)( (again|so much|there))?[\s!.,?🙂😊👍🙏]*$/i;
export function isSmallTalk(message) {
  return SMALL_TALK.test(message.trim());
}

// Phase 10: a question in another language is searched in English. The
// handbook is English and the nomic embedding model is English-first: before
// this, 5 of 18 Malayalam, Hindi and Spanish questions found their passage -
// the ones naming "FMLA", which the keyword search matched
// (eval/multilingual-eval.js). Only the search and the relevance judge see
// the translation; the agent still answers the message as written, so it
// replies in the user's language.
// Whether to translate is decided in code, so English questions cost no
// extra call (looksNonEnglish, replyLanguage.js).
// TRANSLATE_SEARCH=0 turns it off, to compare.
const TRANSLATE_SEARCH = process.env.TRANSLATE_SEARCH !== "0";
const TRANSLATE_SCHEMA = {
  type: "object",
  properties: { english: { type: "string" } },
  required: ["english"],
};
const TRANSLATE_PROMPT =
  "Translate the user's question into English, for searching English documents. Keep names, acronyms, codes " +
  "and numbers exactly as written. Translate only - do not answer, explain or add anything. If it is already " +
  "English, return it unchanged.";

async function englishForSearch(question) {
  if (!TRANSLATE_SEARCH || !looksNonEnglish(question)) return question;
  const res = await chat({
    model: JUDGE_MODEL,
    reasoningEffort: JUDGE_REASONING_EFFORT,
    label: "translate",
    format: TRANSLATE_SCHEMA,
    messages: [
      { role: "system", content: TRANSLATE_PROMPT },
      { role: "user", content: question },
    ],
  });
  let english = "";
  try {
    english = JSON.parse(res.content).english?.trim() ?? "";
  } catch {
    // unparseable: search with the question as written, as before
  }
  // Empty, or still not English: no better than the original.
  return english && !NON_LATIN_LETTER.test(english) ? english : question;
}

// Returns the chunks the agent should read (at most 4) and the decision
// about them, in the shape the agents already use. `searchedAs` is set when
// the question was translated for the search.
export async function retrieve(question, opts = {}) {
  const english = await englishForSearch(question);
  const result = await searchAndJudge(english, opts);
  return english === question ? result : { ...result, searchedAs: english };
}

async function searchAndJudge(question, { rerank = RERANK } = {}) {
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
