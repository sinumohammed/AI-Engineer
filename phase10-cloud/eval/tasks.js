// Step 5: POST /api/ask/task (api/tasks.js) - an app's small AI jobs. A fake
// OpenAI-format model server stands in for Groq, so this checks what the
// service sends and how it answers, with no AI key and no cost: the app's key
// is needed; text goes to the task model, a photo to the vision model as an
// image part; the reply's JSON comes back as an object (code fences and all);
// a reply that is not JSON, a bad request and a used-up app limit are refused
// plainly; a refused request is not counted.
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
const seen = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  });
}).listen(FAKE);

const env = {
  LLM_PROVIDER: "openai", LLM_BASE_URL: `http://localhost:${FAKE}/v1`, LLM_API_KEY: "fake",
  CHAT_MODEL: "fake-chat", JUDGE_MODEL: "fake-small", VISION_MODEL: "fake-vision", TASK_MODEL: "",
  APPS_KEY: `apps:registry:${RUN}`, APP_LIMITS_KEY: `apps:limits:${RUN}`, ASK_KEYS_KEY: `ask:keys:${RUN}`,
  APP_API_KEYS: `${APP}=${ASK_KEY}`, APP_DAILY_LIMIT: "4", PORT: String(PORT), ACCESS_CODE: "", FALLBACK_MODEL: "",
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

  reply = "{}";
  const fourth = await task({ instructions: "x", input: "y" });
  const fifth = await task({ instructions: "x", input: "y" });
  check("the app's daily limit counts tasks (4 a day here): the fifth is refused", fourth.status === 200 && fifth.status === 429, `${fourth.status} ${fifth.status} ${fifth.body.error ?? ""}`);
} finally {
  server.kill();
  fake.close();
}
console.log(`\n${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
