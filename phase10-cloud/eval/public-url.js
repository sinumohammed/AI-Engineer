// Phase 10 step 6: the app as a browser uses it - over HTTP against a
// deployed API (API_URL, default the Vercel one), with the access code
// (HOSTED_ACCESS_CODE from .env), the answer stream, and the conversation
// kept by the server in Redis between questions. Same kind of checks as
// single-agent-eval.js, in both modes.
const API_URL = process.env.API_URL ?? "https://ai-engineer-api-jet.vercel.app";
const CODE = process.env.HOSTED_ACCESS_CODE ?? "";

const normalize = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
const REFUSAL = ["don't know", "do not know", "don't have information", "do not have information", "don't have any information", "not aware of", "don't have access", "no information", "does not contain", "doesn't contain"];
// Asked in order, in one conversation per mode: the last one is a follow-up.
const cases = [
  { q: "What is our rollback process?", must: [["redeploy", "re-deploy"], "tagged release"] },
  { q: "When does the on-call rotation hand off?", must: ["monday", ["10am", "10 am", "10:00 am", "10 a.m."]] },
  { q: "What is the capital of France?", must: ["paris"] },
  { q: "What is the calibration schedule for XJ-9999?", must: [REFUSAL], mustNot: ["90 days"] },
  { q: "How many weeks of unpaid leave does FMLA entitle me to?", must: ["12"] },
  { q: "And who is eligible for it?", must: [["one year of federal service", "1 year of federal service", "a year of federal service"]] },
];

async function ask(sessionId, mode, q) {
  const url = `${API_URL}/api/chat/stream?sessionId=${sessionId}&mode=${mode}&code=${encodeURIComponent(CODE)}&q=${encodeURIComponent(q)}`;
  const started = Date.now();
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}`, ms: Date.now() - started };
  const text = await res.text();
  const events = text.split("\n\n").map((block) => ({
    event: block.match(/^event: (.*)$/m)?.[1],
    data: block.match(/^data: (.*)$/m)?.[1],
  }));
  const answer = events.filter((e) => e.event === "answer_chunk").map((e) => JSON.parse(e.data).text).join("").trim();
  const error = events.find((e) => e.event === "error");
  const notices = events.filter((e) => e.event === "notice").map((e) => JSON.parse(e.data).text);
  return { answer, error: error && JSON.parse(error.data).message, notices, ms: Date.now() - started };
}

const access = await (await fetch(`${API_URL}/api/access`, { headers: { "x-access-code": CODE } })).json();
console.log(`API ${API_URL} - access code ${access.required ? (access.ok ? "accepted" : "REJECTED") : "not required"}\n`);
let passed = 0, total = 0;
for (const mode of ["single", "multi"]) {
  const sessionId = `eval-public-${mode}-${Date.now()}`;
  for (const c of cases) {
    total++;
    const r = await ask(sessionId, mode, c.q);
    const text = normalize(r.answer ?? "");
    const missing = (c.must ?? []).filter((m) => ![m].flat().some((alt) => text.includes(normalize(alt))));
    const forbidden = (c.mustNot ?? []).filter((m) => text.includes(normalize(m)));
    const ok = !r.error && missing.length === 0 && forbidden.length === 0;
    if (ok) passed++;
    console.log(`${ok ? "✅" : "❌"} [${mode}] ${String(r.ms).padStart(5)} ms  ${c.q}`);
    if (!ok) console.log(`     ${r.error ? `error: ${r.error}` : `answer: ${r.answer.slice(0, 200)}`}`);
    for (const n of r.notices ?? []) console.log(`     notice: ${n}`);
  }
  await fetch(`${API_URL}/api/chat/session/${sessionId}`, { method: "DELETE", headers: { "x-access-code": CODE } });
}
console.log(`\n${passed}/${total} passed.`);
