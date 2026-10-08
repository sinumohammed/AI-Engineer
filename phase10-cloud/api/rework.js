// Phase 10: requests to rework the previous answer - "tell that in Malayalam",
// "translate it to Hindi", "make it shorter", "summarise that". Found by
// using the deployed app: such a request was treated as a new question.
// The follow-up rewrite turned "tell that in malayalam" into the search
// "tell FMLA in malayalam", the search found nothing that answers it, and
// the company_docs specialist replied "I don't have information about that
// in the company documents" - although the answer was already in the
// conversation. Nothing needs searching: the model reworks what was said.
//
// Decided in code from the wording of the WHOLE message (like isSmallTalk
// in retrieve.js), and only when there is an earlier answer to rework. A
// message with a new question in it ("What is FMLA? Answer in Malayalam")
// is not matched, and goes through search as usual.
import { chat } from "./llmClient.js";
import { CHAT_MODEL } from "./config.js";

const LANGUAGES =
  "english|malayalam|hindi|arabic|tamil|telugu|kannada|urdu|bengali|marathi|gujarati|punjabi|nepali|sinhala|" +
  "french|spanish|german|italian|portuguese|dutch|polish|greek|russian|turkish|persian|farsi|hebrew|" +
  "chinese|mandarin|japanese|korean|thai|vietnamese|indonesian|malay|tagalog|filipino|swahili";
const IT = "(that|it|this|the answer|your answer|the above|above|the same)";
const REWORK = new RegExp(
  "^(please |can you |could you |pls )?(" +
    [
      `(translate|convert)( ${IT})?( (to|into|in) (${LANGUAGES}))?`,
      `(say|tell|write|give|explain|answer|reply|respond|repeat|show|put)( me)?( ${IT})? in (${LANGUAGES})( language)?`,
      `(in|into) (${LANGUAGES})( language)?`,
      `(${LANGUAGES})`,
      `(summari[sz]e|shorten|simplify|rephrase|reword|rewrite)( ${IT})?`,
      `make ${IT} (shorter|simpler|clearer|easier|more detailed|longer)`,
      `explain ${IT} (again|more simply|simply|in simple (words|terms)|like i'?m (5|five))`,
      `(in )?(bullet points|a table|one sentence|simple (words|terms))`,
    ].join("|") +
    ")( please| pls)?[\\s.!?]*$",
  "i"
);

export function isRework(message, history = []) {
  return history.some((m) => m.role === "assistant") && REWORK.test(message.trim());
}

const REWORK_PROMPT =
  "The user asks you to rework your previous answer in this conversation: translate it, shorten it, simplify " +
  "it or change its format, exactly as they say. Use only the facts already in the conversation and add no new " +
  "ones. Leave out citation markers such as [1]: the sources are listed under the original answer.";

// One model call with the whole conversation. Unlike the supervisor's
// specialists (historyFor, Phase 8c), nothing is hidden: the user has
// already seen the answer being reworked. `fromCompanyDocs` is carried over
// from that answer, so a translated document answer stays tagged and stays
// hidden from the general and coding specialists in later turns.
export async function answerRework({ question, history, summary, model = CHAT_MODEL }) {
  const previous = [...history].reverse().find((m) => m.role === "assistant");
  const res = await chat({
    model,
    label: "rework",
    messages: [
      { role: "system", content: REWORK_PROMPT },
      ...(summary ? [{ role: "system", content: `Summary of earlier conversation: ${summary}` }] : []),
      ...history.map(({ role, content }) => ({ role, content })),
      { role: "user", content: question },
    ],
  });
  return {
    answer: res.content,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    fromCompanyDocs: previous?.fromCompanyDocs === true,
  };
}
