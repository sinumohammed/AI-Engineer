// Phase 10: is the answer in the language of the question? (replyLanguage.js)
// Malayalam and Hindi are checked by script; Spanish and English by common
// words. Runs the single agent and the multi-agent supervisor.
const CASES = [
  { lang: "Malayalam", question: "കോമ്പ് ടൈം എപ്പോഴാണ് കാലഹരണപ്പെടുന്നത്?", check: (a) => /[ഀ-ൿ]/.test(a) && !/\b(the|is|are)\b/i.test(a.replace(/\[[^\]]*\]/g, "")) },
  { lang: "Hindi", question: "FMLA के लिए कौन पात्र है?", check: (a) => /[ऀ-ॿ]/.test(a) },
  { lang: "Spanish", question: "¿Cuánto permiso parental pagado me corresponde?", check: (a) => /\b(de|que|semanas|permiso)\b/i.test(a) && !/\b(the|weeks)\b/i.test(a) },
  // The exact text the voice test produced on the live app - answered in English there.
  { lang: "Malayalam", question: "കോം ടൈം എപ്പോഴാണ് കാലഹരണപ്പെടുന്നത്?", check: (a) => /[\u0D00-\u0D7F]/.test(a) && !/\b(the|is|are)\b/i.test(a.replace(/\[[^\]]*\]/g, "")) },
  // Switching language mid-conversation: the earlier turns are English.
  {
    lang: "Malayalam",
    note: "after English turns",
    history: [
      { role: "user", content: "How much paid parental leave do I get?" },
      { role: "assistant", content: "You get 12 weeks of paid parental leave for the birth, adoption or placement of a new child [1].", fromCompanyDocs: true },
    ],
    question: "ഓഫ്ബോർഡിംഗ് എന്റെ അവസാന ദിവസത്തിന് എത്ര മുമ്പ് തുടങ്ങണം?",
    check: (a) => /[\u0D00-\u0D7F]/.test(a) && !/\b(the|is|are|your)\b/i.test(a.replace(/\[[^\]]*\]/g, "")),
  },
  { lang: "English", question: "How much paid parental leave do I get?", check: (a) => /\b(the|weeks|you)\b/i.test(a) && !/[ऀ-ൿ]/.test(a) },
];
// ONLY=Malayalam,English runs those languages only - to confirm a fix on
// Groq without spending the day's quota on every case.
const ONLY = process.env.ONLY?.split(",");
const cases = ONLY ? CASES.filter((c) => ONLY.includes(c.lang)) : CASES;
let passed = 0;
let total = 0;
// MODES=multi runs one architecture only.
for (const mode of process.env.MODES?.split(",") ?? ["single", "multi"]) {
  const { runAgent } = await import(mode === "single" ? "../api/agent.js" : "../api/supervisor.js");
  console.log(`\n${mode === "single" ? "Single agent" : "Multi-agent"}:`);
  for (const c of cases) {
    const { answer } = await runAgent(c.question, c.history ?? []);
    const ok = c.check(answer);
    total++;
    if (ok) passed++;
    console.log(`  ${ok ? "✅" : "❌"} ${(c.lang + (c.note ? ` (${c.note})` : "")).padEnd(9)} ${answer.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
console.log(`\nAnswered in the question's language: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
