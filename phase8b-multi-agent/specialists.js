// The specialist agents the supervisor hands tasks to. Each one is narrow on
// purpose: its own system prompt, its own inputs, and no knowledge of the
// other agents.
//
// A specialist is split into two steps so both supervisors can share it:
//   prepare(question) -> { systemContent, meta }   what to tell the model
//                     or { answer, meta }           an answer decided in code
//   runSpecialist()   -> prepare + the hand-rolled model call (llm.js)
// The LangGraph supervisor calls prepare() and makes the model call itself
// through ChatOllama, so the prompts and retrieval stay identical.
import { toolImpls } from "../phase5-rag/tools.js";
import { RELEVANCE_THRESHOLD } from "../phase5-rag/config.js";
import { chat, SPECIALIST_MODEL } from "./llm.js";

// Retrieval plus the same in-code relevance gate the single agent uses.
// Exported because the supervisor also runs it BEFORE routing, to show the
// router what the documents contain (see routing.js).
export async function searchDocs(question) {
  const docResults = await toolImpls.search_company_docs({ query: question });

  const identifierMismatch = Array.isArray(docResults) && docResults.identifierMismatch === true;
  const isRelevant =
    !identifierMismatch &&
    Array.isArray(docResults) &&
    (docResults.bestVectorDistance < RELEVANCE_THRESHOLD || docResults.keywordHit);
  return {
    docResults,
    isRelevant,
    identifierMismatch,
    bestDistance: Array.isArray(docResults) ? docResults.bestVectorDistance : null,
  };
}

// Always-retrieve RAG, same retrieval and same prompt wording as the
// single-agent version (phase6-ui/server/agent.js), so the comparison varies
// the architecture and not the prompts. One real difference: the single agent
// falls back to general knowledge when nothing relevant is found. This
// specialist must NOT - answering a company question from general knowledge
// is exactly the hallucination Phase 6.8 fixed - so "nothing relevant" is a
// refusal decided in code, with no model call at all.
async function prepareCompanyDocs(question) {
  const { docResults, isRelevant, identifierMismatch, bestDistance } = await searchDocs(question);
  const meta = { isRelevant, identifierMismatch, bestDistance };

  if (identifierMismatch) {
    return {
      systemContent:
        "You are a helpful assistant. The user asked about a specific code or ID that does not appear in the " +
        "company documents. Say plainly that you don't have information about that specific identifier - do not " +
        "substitute or guess a similar one from the documents.",
      meta,
    };
  }

  if (!isRelevant) {
    return { answer: "I don't have information about that in the company documents.", meta };
  }

  return {
    systemContent:
      "You are a helpful assistant. The company document excerpt below is relevant to the user's question. " +
      "Read it carefully and answer specifically using the facts it contains. Only if it truly does not " +
      "address the question at all, say plainly that you don't know.\n\n" +
      "Company document excerpt:\n" +
      docResults.map((r) => `[${r.source}] ${r.content}`).join("\n---\n"),
    meta,
  };
}

// `description` is what the router reads to decide who gets a task - it is
// the only thing the router knows about a specialist, so it is written for
// that reader, not for humans browsing this file.
export const specialists = {
  company_docs: {
    description:
      "Questions about THIS company: its internal processes, policies, schedules, on-call, deployments, " +
      "equipment and equipment codes - typically phrased with \"our\" or \"we\". Answers only from the company's documents.",
    prepare: prepareCompanyDocs,
  },
  coding: {
    description:
      "Programming and software questions that do not depend on this company: writing or explaining code, " +
      "debugging errors, languages, libraries, SQL, git and other command-line tools.",
    prepare: async () => ({
      systemContent:
        "You are a senior software engineer helping a colleague. Answer programming, debugging and command-line " +
        "questions directly and concisely, with a short code example when it helps. You have no access to this " +
        "company's internal documents or systems - if the question depends on them, say so instead of guessing.",
      meta: {},
    }),
  },
  general: {
    description:
      "Everything else: general knowledge, facts, math, everyday questions, and questions about this conversation itself.",
    prepare: async () => ({
      systemContent:
        "You are a helpful assistant. Answer the user's question from your own knowledge, briefly. If the user asks " +
        "about something they told you earlier in this conversation, use the earlier messages. You have no access " +
        "to this company's internal documents - if the question depends on them, say so instead of guessing.",
      meta: {},
    }),
  },
};

// The messages a specialist's model call gets: its system prompt, the
// conversation so far, then the task.
export function specialistMessages(systemContent, question, history) {
  return [{ role: "system", content: systemContent }, ...history, { role: "user", content: question }];
}

// Every specialist returns the same shape, so the supervisor can dispatch to
// any of them without special cases.
export async function runSpecialist(name, question, history = []) {
  const prep = await specialists[name].prepare(question);
  if (prep.answer !== undefined) {
    return { answer: prep.answer, llmCalls: 0, promptTokens: 0, completionTokens: 0, meta: prep.meta };
  }
  const res = await chat({
    model: SPECIALIST_MODEL,
    label: name,
    messages: specialistMessages(prep.systemContent, question, history),
  });
  return {
    answer: res.content,
    llmCalls: 1,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    meta: prep.meta,
  };
}
