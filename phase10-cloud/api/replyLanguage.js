// Phase 10: answer in the language the user wrote in. Seen on the live app:
// a Malayalam question (asked by voice) was answered in English, while a
// typed Malayalam question had been answered in Malayalam - the model
// sometimes follows the English document excerpts instead of the user.
//
// The user's own message is quoted, because a specialist may be handed the
// router's rewording of it (routing.js) rather than what the user wrote.
// Asking to translate or rewrite an answer ("tell that in Malayalam") is a
// different request with its own prompt (rework.js), not affected by this.
//
// Only added when the message is not English. Added to every message, it
// changed how local qwen worded English answers: "is not mentioned" instead
// of "I don't know" (single agent 10/10 -> 9/10), and a "[company_docs]"
// label leaked into a joined answer (supervisor 3/3 -> 2/3). English
// questions now get exactly the prompts they had before.
const MAX_QUOTE = 300;

// Is this message in another language? Decided in code, so English costs
// nothing: a letter outside the Latin script (Malayalam, Hindi, Arabic...),
// or three or more words with none of these common English words. Also
// decides whether the search translates the question (retrieve.js) - 0 of
// 87 English eval questions are flagged.
export const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;
const ENGLISH_WORDS = new Set(
  "the is are was do does did what how when where who which why can could should will would must my our your i we you they to of for and with it be have has get there this that".split(" ")
);
export function looksNonEnglish(text) {
  if (NON_LATIN_LETTER.test(text)) return true;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.length >= 3 && !words.some((w) => ENGLISH_WORDS.has(w));
}
// REPLY_LANGUAGE=0 leaves the rule out, to compare.
const ON = process.env.REPLY_LANGUAGE !== "0";

export function replyLanguageRule(userMessage) {
  if (!ON || !looksNonEnglish(userMessage)) return "";
  const quote = userMessage.length > MAX_QUOTE ? `${userMessage.slice(0, MAX_QUOTE)}…` : userMessage;
  return (
    "\n\nWrite your whole reply in the language of the user's message below, even when the document excerpts, " +
    "the earlier conversation or your instructions are in English. Keep names, codes, commands and code in their " +
    `original form.\nThe user's message: «${quote}»`
  );
}
