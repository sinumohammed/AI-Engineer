// Retrieval test cases for the public corpus (phase5-rag/docs/).
// `mustFind` is a short piece of text copied from the passage that answers
// the question. A case is a hit when a retrieved chunk contains it - so this
// checks that search found the ANSWER, not merely the right file (the
// handbook's largest page is 47,000 characters, about 60 chunks).
// Every `mustFind` was copied from the corpus; `npm run eval` reports any
// that no single chunk contains.

// Questions worded close to the document's own wording.
export const direct = [
  { question: "How many hours of annual leave can I carry over to the next year?", mustFind: "maximum of 240 annual leave hours" },
  { question: "How much paid parental leave do I get?", mustFind: "12 weeks of paid time off" },
  { question: "How long must I have been a federal employee to use paid parental leave?", mustFind: "federal employee for 12 months" },
  { question: "How quickly must I report a suspected security incident?", mustFind: "within 1 hour of suspected incident" },
  { question: "What equipment does GSA issue to every TTS employee?", mustFind: "badge, laptop, and phone" },
  { question: "What do I do if TTS-issued equipment is lost or stolen?", mustFind: "equipment is lost or stolen, follow these mandatory steps" },
  { question: "When does comp time expire?", mustFind: "Comp time expires one year" },
  { question: "What is the maximum salary at GSA?", mustFind: "$191,900" },
  { question: "How many weeks of unpaid leave does FMLA entitle me to?", mustFind: "up to 12 weeks of _unpaid_ leave" },
  { question: "How much advanced sick leave can I request?", mustFind: "up to 240 hours of advanced sick leave" },
  { question: "How often should 1:1s be held and how long should they be?", mustFind: "half-hour 1:1s weekly" },
  { question: "How long before my last day should I begin the offboarding process?", mustFind: "at least two weeks before your last day" },
  { question: "How long does it take for a travel voucher to be reviewed?", mustFind: "reviewed in 3-5 business days" },
  { question: "Are Slack messages subject to FOIA?", mustFind: "are subject to FOIA" },
  { question: "Should git commits be cryptographically signed?", mustFind: "all git commits to be cryptographically signed" },
  { question: "Which Zoom domain do I enter to sign in?", mustFind: "gsa.zoomgov.com" },
  { question: "On which schedule can I earn credit hours?", mustFind: "you can earn/use credit hours if you are on a flexible schedule" },
  { question: "Can my last day at TTS be a federal holiday?", mustFind: "cannot be a federal holiday" },
  // mustFind is the visible link text, not its address: from step 9.2 on,
  // cleaned chunks keep link text and drop URLs.
  { question: "Where is the GSA bug bounty program run?", mustFind: "GSA administers a Bug Bounty Program" },
  { question: "Who is eligible for FMLA?", mustFind: "at least one year of federal service" },
];

// The same facts asked the way a person would, sharing few words with the
// document. This is where vector search is supposed to earn its keep.
export const paraphrased = [
  { question: "Can I roll my unused vacation days into next year?", mustFind: "maximum of 240 annual leave hours" },
  { question: "We're having a baby. How much time off will I be paid for?", mustFind: "12 weeks of paid time off" },
  { question: "I think my account was hacked. How fast do I need to tell someone?", mustFind: "within 1 hour of suspected incident" },
  { question: "Someone took my work laptop at the airport. What now?", mustFind: "equipment is lost or stolen, follow these mandatory steps" },
  { question: "I'm resigning. How far ahead should I start the paperwork?", mustFind: "at least two weeks before your last day" },
  { question: "When will I get my money back after a work trip?", mustFind: "reviewed in 3-5 business days" },
  { question: "Is there a pay ceiling that stops me from getting overtime?", mustFind: "$191,900" },
  { question: "Can journalists request what I write in chat?", mustFind: "are subject to FOIA" },
  { question: "What kit will I be given when I join?", mustFind: "badge, laptop, and phone" },
  { question: "Do the extra hours I banked instead of overtime pay ever run out?", mustFind: "Comp time expires one year" },
];

// The three facts in the original two sample documents. They passed
// trivially when the corpus was 2 chunks; now they compete with 2,300 others.
export const original = [
  { question: "What is our rollback process?", mustFind: "re-deploying the previous tagged release" },
  { question: "When does the on-call rotation hand off?", mustFind: "every Monday at 10am" },
  { question: "What is the calibration schedule for XJ-2200?", mustFind: "calibration every 90 days" },
];

// Questions the documents do not answer. Search should NOT call any chunk
// relevant for these. They show how far apart "relevant" and "irrelevant"
// still are at this corpus size.
export const offTopic = [
  "What is the capital of France?",
  "Who wrote Pride and Prejudice?",
  "How many minutes are there in a day?",
  "What is the boiling point of water?",
  "How do I reverse a string in JavaScript?",
  "Why does my Python loop throw IndexError: list index out of range?",
  "Write a SQL query to find duplicate emails in a users table.",
  "How do I list all git tags from the command line?",
];

// Phase 10: the same facts asked in other languages. The handbook and the
// embedding model are English-first, so these test whether a question in
// Malayalam, Hindi or Spanish still finds the English passage.
const ML = {
  carry: "എനിക്ക് എത്ര മണിക്കൂർ വാർഷിക അവധി അടുത്ത വർഷത്തേക്ക് മാറ്റാൻ കഴിയും?",
  parental: "എനിക്ക് എത്ര ശമ്പളത്തോടെയുള്ള പേരന്റൽ ലീവ് ലഭിക്കും?",
  incident: "സംശയാസ്പദമായ ഒരു സുരക്ഷാ സംഭവം എത്ര വേഗം റിപ്പോർട്ട് ചെയ്യണം?",
  fmla: "FMLA-യ്ക്ക് ആർക്കാണ് അർഹത?",
  comp: "കോമ്പ് ടൈം എപ്പോഴാണ് കാലഹരണപ്പെടുന്നത്?",
  offboard: "ഓഫ്ബോർഡിംഗ് പ്രക്രിയ എന്റെ അവസാന ദിവസത്തിന് എത്ര മുമ്പ് തുടങ്ങണം?",
};
const HI = {
  carry: "मैं अगले साल के लिए कितने घंटे की वार्षिक छुट्टी आगे ले जा सकता हूँ?",
  parental: "मुझे कितनी सवेतन पैरेंटल लीव मिलती है?",
  incident: "संदिग्ध सुरक्षा घटना की रिपोर्ट कितनी जल्दी करनी होती है?",
  fmla: "FMLA के लिए कौन पात्र है?",
  comp: "कॉम्प टाइम कब समाप्त होता है?",
  offboard: "ऑफबोर्डिंग प्रक्रिया मेरे आखिरी दिन से कितने समय पहले शुरू करनी चाहिए?",
};
const ES = {
  carry: "¿Cuántas horas de vacaciones anuales puedo transferir al año siguiente?",
  parental: "¿Cuánto permiso parental pagado me corresponde?",
  incident: "¿Con qué rapidez debo informar de un posible incidente de seguridad?",
  fmla: "¿Quién tiene derecho al FMLA?",
  comp: "¿Cuándo caduca el tiempo compensatorio?",
  offboard: "¿Cuánto tiempo antes de mi último día debo empezar el proceso de salida?",
};
const ANSWERS = {
  carry: "maximum of 240 annual leave hours",
  parental: "12 weeks of paid time off",
  incident: "within 1 hour of suspected incident",
  fmla: "at least one year of federal service",
  comp: "Comp time expires one year",
  offboard: "at least two weeks before your last day",
};
export const multilingual = Object.fromEntries(
  Object.entries({ Malayalam: ML, Hindi: HI, Spanish: ES }).map(([lang, qs]) => [
    lang,
    Object.entries(qs).map(([key, question]) => ({ question, mustFind: ANSWERS[key] })),
  ])
);
// Must NOT be treated as answered by the handbook.
export const multilingualOffTopic = [
  "ഫ്രാൻസിന്റെ തലസ്ഥാനം ഏതാണ്?",
  "जावास्क्रिप्ट में स्ट्रिंग को उल्टा कैसे करें?",
  "¿Quién escribió Don Quijote?",
];
