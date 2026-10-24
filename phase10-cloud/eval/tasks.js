// Step 5: POST /api/ask/task (api/tasks.js) - an app's small AI jobs. A fake
// OpenAI-format model server stands in for Groq, so this checks what the
// service sends and how it answers, with no AI key and no cost: the app's key
// is needed; text goes to the task model, a photo to the vision model as an
// image part; the reply's JSON comes back as an object (code fences and all);
// a reply that is not JSON, a bad request and a used-up app limit are refused
// plainly; a refused request is not counted.
// Also the Command Center's model alert (api/modelCheck.js): a model in use that the provider
// no longer lists, or that answered "model not found", is named with the setting to change.
//   npm run eval:tasks
import { spawn } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3021;
const FAKE = 3022;
const AI = `http://localhost:${PORT}`;
const ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const RUN = `tasks-eval-${process.pid}`;
const APP = `taskapp${process.pid % 100000}`;

let reply = "{}";
let listed = ["fake-small", "fake-vision"]; // fake-chat is "retired"
let gone = null; // a model that answers 404 model_not_found
const seen = [];
const fake = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/v1/models") return res.end(JSON.stringify({ data: listed.map((id) => ({ id })) }));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body);
    seen.push(b);
    if (b.model === gone) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { message: `The model \`${gone}\` does not exist or you do not have access to it.`, code: "model_not_found" } }));
    }
    res.setHeader("x-ratelimit-limit-requests", "1000"); // as Groq does: a working call clears the alert
    res.setHeader("x-ratelimit-remaining-requests", "999");
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
}).listen(FAKE);

const env = {
  LLM_PROVIDER: "openai", LLM_BASE_URL: `http://localhost:${FAKE}/v1`, LLM_API_KEY: "fake",
  CHAT_MODEL: "fake-chat", JUDGE_MODEL: "fake-small", VISION_MODEL: "fake-vision", TASK_MODEL: "",
  APPS_KEY: `apps:registry:${RUN}`, APP_LIMITS_KEY: `apps:limits:${RUN}`, ASK_KEYS_KEY: `ask:keys:${RUN}`,
  APP_API_KEYS: `${APP}=${ASK_KEY}`, APP_DAILY_LIMIT: "6", PORT: String(PORT), ACCESS_CODE: "", FALLBACK_MODEL: "",
  MODELS_LIST_KEY: `models:${RUN}`, LIMITS_KEY: `limits:${RUN}`, ADMIN_KEY: `adm_${randomBytes(18).toString("base64url")}`,
};

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += Boolean(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${String(detail).slice(0, 200)}` : ""}`);
}
const task = async (body, token = ASK_KEY) => {
  const res = await fetch(`${AI}/api/ask/task`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const server = spawn(process.execPath, ["--env-file=../.env", "server.js"], { cwd: new URL("../api/", import.meta.url).pathname, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${AI}/api/access`).then(() => true, () => false)) break;
    await sleep(500);
  }

  const noKey = await task({ instructions: "x", input: "y" }, null);
  check("no key: refused", noKey.status === 401, noKey.status);

  reply = '```json\n{"lines":[{"name":"Brake pads","qty":1,"price":24}]}\n```';
  const text = await task({ instructions: "Draft a quote. JSON: {lines}", input: "Brake noise", user: { ref: "garage:g1" } });
  check("text task: the JSON comes back as an object", text.status === 200 && text.body.result?.lines?.[0]?.name === "Brake pads", JSON.stringify(text.body));
  const t = seen.at(-1);
  check("text task: the task model, with the app's instructions and input", t.model === "fake-small" && /Draft a quote/.test(t.messages[0].content) && t.messages[1].content === "Brake noise", JSON.stringify(t).slice(0, 200));

  reply = 'Here it is: {"plate":"4521 AB","make":"TOYOTA"}';
  const photo = Buffer.from("fake jpeg").toString("base64");
  const vision = await task({ instructions: "Read the card", image: { mimeType: "image/jpeg", data: photo } });
  check("photo task: read", vision.status === 200 && vision.body.result?.plate === "4521 AB" && vision.body.model === "fake-vision", JSON.stringify(vision.body));
  const v = seen.at(-1);
  const parts = v.messages[1].content;
  check("photo task: the vision model gets the photo as an image part, thinking off", v.model === "fake-vision" && parts[1]?.image_url?.url === `data:image/jpeg;base64,${photo}` && v.reasoning_effort === "none", JSON.stringify(v).slice(0, 200));

  reply = "Sorry, I cannot read that.";
  const notJson = await task({ instructions: "Read the card", input: "?" });
  check("a reply that is not JSON: 502 with a plain message", notJson.status === 502 && /not JSON/.test(notJson.body.error), JSON.stringify(notJson.body));

  const bad = await Promise.all([
    task({ input: "no instructions" }),
    task({ instructions: "x" }),
    task({ instructions: "x", image: { mimeType: "application/pdf", data: photo } }),
    task({ instructions: "x", input: "y", user: { ref: "has spaces" } }),
  ]);
  check("bad requests: 400, not counted", bad.every((b) => b.status === 400), bad.map((b) => b.status).join(","));

  // The model alert. The provider's list lacks the chat model: named ahead of time, with every
  // setting that uses it; the models it lists raise nothing.
  const alerts = async () => (await (await fetch(`${AI}/api/admin/usage?days=1`, { headers: { Authorization: `Bearer ${env.ADMIN_KEY}` } })).json()).modelAlerts;
  const a0 = await alerts();
  const chatAlert = a0?.find((a) => a.model === "fake-chat");
  check("model alert: a model the provider no longer lists is named before anything fails", a0?.length === 1 && chatAlert && /no longer lists/.test(chatAlert.reason) && ["CHAT_MODEL", "ROUTER_MODEL", "SPECIALIST_MODEL"].every((x) => chatAlert.settings.includes(x)), JSON.stringify(a0));

  // The vision model answers "model not found" (as Llama 4 Maverick did live): named, with its setting.
  gone = "fake-vision";
  const failed = await task({ instructions: "Read the card", image: { mimeType: "image/jpeg", data: photo } });
  const a1 = await alerts();
  const v1 = a1?.find((a) => a.model === "fake-vision");
  check("model alert: a 'model not found' answer names the model and VISION_MODEL", failed.status >= 500 && v1 && v1.settings.includes("VISION_MODEL") && /model not found/.test(v1.reason) && /Mulkiya/.test(v1.purposes.join()), JSON.stringify(a1));

  // Fixed (the model works again): the alert goes.
  gone = null;
  reply = '{"ok":true}';
  await task({ instructions: "Read the card", image: { mimeType: "image/jpeg", data: photo } });
  const a2 = await alerts();
  check("model alert: gone once the model answers again", !a2?.some((a) => a.model === "fake-vision"), JSON.stringify(a2));

  // The Command Center's app filter: tasks count as uses, and the users list ranks this app's garages.
  const report = async (q) => (await fetch(`${AI}/api/admin/usage?days=1${q}`, { headers: { Authorization: `Bearer ${env.ADMIN_KEY}` } })).json();
  const mine = await report(`&app=${APP}`);
  const g1 = mine.byUser?.find((u) => u.user_ref === "garage:g1");
  check("usage filtered to the app: only its rows, tasks counted as uses, its garage ranked",
    mine.app === APP && mine.byApp?.length === 1 && mine.byApp[0].caller === APP && mine.byApp[0].tasks === 5 && mine.byApp[0].questions === mine.byApp[0].tasks && g1?.questions === 1 && mine.everyApp?.includes(APP),
    JSON.stringify({ app: mine.app, byApp: mine.byApp, g1 }));
  const none = await report("&app=no-such-app");
  check("another app's filter shows none of it", none.byApp?.length === 0 && !none.byUser?.length && none.everyApp?.includes(APP), JSON.stringify(none.byApp));

  reply = "{}";
  const sixth = await task({ instructions: "x", input: "y" });
  const seventh = await task({ instructions: "x", input: "y" });
  check("the app's daily limit counts tasks (6 a day here): the seventh is refused", sixth.status === 200 && seventh.status === 429, `${sixth.status} ${seventh.status} ${seventh.body.error ?? ""}`);
} finally {
  server.kill();
  fake.close();
}
console.log(`\n${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
