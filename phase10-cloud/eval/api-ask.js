// Phase 10d: POST /api/ask as another app uses it - JSON in, JSON out, with
// an app key (ASK_API_KEY from .env, an APP_API_KEYS key on the server).
// API_URL defaults to the deployed API; http://localhost:3002 for the Mac.
// The key checks cost no model quota; only three questions are asked.
const API_URL = process.env.API_URL ?? "https://ai-engineer-api-jet.vercel.app";
const KEY = process.env.ASK_API_KEY ?? "";

const normalize = (s) => s.toLowerCase().replace(/[‘’]/g, "'");
const ask = async (body, { key = KEY, raw } = {}) => {
  const started = Date.now();
  const res = await fetch(`${API_URL}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), ms: Date.now() - started };
};

let passed = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (ok) passed++;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok && detail) console.log(`     ${detail}`);
}
const has = (text, ...alts) => alts.some((a) => normalize(text ?? "").includes(normalize(a)));

console.log(`API ${API_URL}${KEY ? "" : " - no ASK_API_KEY set"}\n`);

// 1. Keys and bad requests - answered before any model is called.
let r = await ask({ question: "hi" }, { key: "" });
check("no key -> 401", r.status === 401, `got ${r.status}`);
r = await ask({ question: "hi" }, { key: "ak_wrong" });
check("wrong key -> 401", r.status === 401, `got ${r.status}`);
r = await ask(null, { raw: "not json" });
check("body not JSON -> 400", r.status === 400, `got ${r.status} ${JSON.stringify(r.body)}`);
r = await ask({ conversationId: "x" });
check("no question -> 400", r.status === 400, `got ${r.status} ${JSON.stringify(r.body)}`);
r = await ask({ question: "hi", mode: "fast" });
check("unknown mode -> 400", r.status === 400, `got ${r.status} ${JSON.stringify(r.body)}`);

// 2. A question on its own, answered from the handbook with sources.
r = await ask({ question: "What is our rollback process?" });
check(
  `standalone question (${r.ms} ms)`,
  r.status === 200 && has(r.body?.answer, "redeploy", "re-deploy") && r.body.fromCompanyDocs && r.body.sources?.length > 0,
  `${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`
);

// 3. A conversation: the follow-up only makes sense with the first question.
const conversationId = `eval-ask-${Date.now()}`;
r = await ask({ question: "How many weeks of unpaid leave does FMLA entitle me to?", conversationId });
check(`conversation, first question (${r.ms} ms)`, r.status === 200 && has(r.body?.answer, "12"), `${r.status} ${r.body?.answer?.slice(0, 200) ?? JSON.stringify(r.body)}`);
r = await ask({ question: "And who is eligible for it?", conversationId });
check(
  `conversation, follow-up (${r.ms} ms)`,
  r.status === 200 && r.body?.conversationId === conversationId && has(r.body?.answer, "one year of federal service", "1 year of federal service", "a year of federal service"),
  `${r.status} ${r.body?.answer?.slice(0, 200) ?? JSON.stringify(r.body)}`
);
for (const n of r.body?.notices ?? []) console.log(`     notice: ${n}`);

const del = await fetch(`${API_URL}/api/ask/conversations/${conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${KEY}` } });
check("forget the conversation", del.ok, `got ${del.status}`);

console.log(`\n${passed}/${total} passed.`);
