// Each app's switch and limits (api/appLimits.js), set from the Command
// Center: the admin key changes them, the dashboard key cannot; a paused app
// is refused at once (questions and voice); daily and monthly limits refuse
// the next question, and a refused question is not counted. Starts this
// service's API on its own Redis keys; one short question goes to the model
// (whatever ../.env says).
//   npm run eval:app-limits
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const apiRequire = createRequire(new URL("../api/package.json", import.meta.url));
const { createClient } = apiRequire("redis");

const PORT = 3019;
const AI = `http://localhost:${PORT}`;
const ADMIN_KEY = randomBytes(24).toString("base64url");
const DASHBOARD_KEY = randomBytes(24).toString("base64url");
const ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const RUN = `limits-eval-${process.pid}`;
const APP = `evalapp${process.pid % 100000}`;
const env = {
  APPS_KEY: `apps:registry:${RUN}`,
  APP_LIMITS_KEY: `apps:limits:${RUN}`,
  ASK_KEYS_KEY: `ask:keys:${RUN}`,
  APP_API_KEYS: `${APP}=${ASK_KEY}`,
  APP_SECRETS_KEY: randomBytes(32).toString("base64"),
  ADMIN_KEY,
  DASHBOARD_KEY,
  APP_DAILY_LIMIT: "100",
  PORT: String(PORT),
  ACCESS_CODE: "",
};

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += Boolean(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${String(detail).slice(0, 160)}` : ""}`);
}
async function call(path, { method = "GET", body, token, raw, type = "application/json" } = {}) {
  const res = await fetch(`${AI}${path}`, {
    method,
    headers: { "Content-Type": type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(300000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const server = spawn(process.execPath, ["--env-file=../.env", "server.js"], { cwd: new URL("../api/", import.meta.url).pathname, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
const row = async () => (await call("/api/admin/app-limits", { token: ADMIN_KEY })).body.apps?.find((a) => a.app === APP);
const ask = () => call("/api/ask", { method: "POST", token: ASK_KEY, body: { question: "Say hello in one word." } });
const setLimits = (body, token = ADMIN_KEY) => call(`/api/admin/app-limits/${APP}`, { method: "PUT", token, body });

try {
  await redis.connect();
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${AI}/api/access`)).ok) break;
    } catch {
      // not up yet
    }
    await sleep(500);
  }

  let r = await call("/api/admin/app-limits", { token: DASHBOARD_KEY });
  check("The dashboard key cannot read the controls", r.status === 401, r.status);
  r = await setLimits({ paused: true }, DASHBOARD_KEY);
  check("…nor pause an app", r.status === 401, r.status);
  r = await call("/api/admin/app-limits", { token: ADMIN_KEY });
  let a = r.body.apps?.find((x) => x.app === APP);
  check("The admin key lists the app: on, APP_DAILY_LIMIT a day, no monthly limit, nothing used", a && !a.paused && a.daily === 100 && a.monthly === 0 && a.usedToday === 0 && a.hasKey, JSON.stringify(a));
  r = await setLimits({ daily: -1 });
  check("A negative limit is refused", r.status === 400, r.body.error);
  r = await setLimits({ paused: "yes" });
  check("paused must be true or false", r.status === 400, r.body.error);

  await setLimits({ paused: true });
  r = await ask();
  check("Paused: the question is refused at once, 403 with the reason", r.status === 403 && /paused/.test(r.body.error), r.body.error);
  r = await call("/api/ask/transcribe", { method: "POST", token: ASK_KEY, raw: Buffer.from("x"), type: "audio/webm" });
  check("Paused: voice input refused too", r.status === 403, r.status);
  a = await row();
  check("…and not counted", a.usedToday === 0, a.usedToday);

  await setLimits({ paused: false, daily: 1 });
  r = await ask();
  check("On again, daily limit 1: the first question is answered", r.status === 200 && r.body.answer, r.body.answer ?? r.body.error);
  r = await ask();
  check("…the second is refused with the daily limit", r.status === 429 && /daily limit of 1 question/.test(r.body.error), r.body.error);
  a = await row();
  check("Used today 1, this month 1 (the refused one not counted)", a.usedToday === 1 && a.usedMonth === 1, `${a.usedToday} / ${a.usedMonth}`);
  r = await call("/api/ask/transcribe", { method: "POST", token: ASK_KEY, raw: Buffer.from("x"), type: "audio/webm" });
  check("Used up: voice input refused", r.status === 429, r.status);

  await setLimits({ daily: 0, monthly: 1 });
  r = await ask();
  check("No daily limit, monthly limit 1 (already used): refused with the monthly limit", r.status === 429 && /monthly limit of 1 question is used up/.test(r.body.error), r.body.error);
  await setLimits({ monthly: 0 });
  a = await row();
  check("Fields left out keep their value; 0 = no limit", a.daily === 0 && a.monthly === 0 && !a.paused, JSON.stringify(a));
} catch (err) {
  console.error(`\nStopped: ${err.message}`);
  total++;
} finally {
  server.kill();
  try {
    const keys = [env.APP_LIMITS_KEY, env.APPS_KEY, env.ASK_KEYS_KEY];
    for await (const k of redis.scanIterator({ MATCH: `app:${APP}:asks:*`, COUNT: 100 })) keys.push(...(Array.isArray(k) ? k : [k]));
    await redis.del(keys);
  } catch {
    // Redis down: nothing stored
  }
  await redis.quit().catch(() => {});
}
console.log(`\n${passed}/${total} passed.`);
process.exit(passed === total ? 0 : 1);
