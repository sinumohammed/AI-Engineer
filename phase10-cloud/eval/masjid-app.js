// The masjid app end to end, on this Mac, with made-up data - never the live
// database. Starts the masjid backend from its own repo (MASJID_REPO) against a
// throwaway Postgres database, and this service's API next to it; fills the
// database through the app's own admin routes; registers the app; then asks:
//
//   1. the masjid backend's AI checks: service token, user token, roles - no model
//   2. the admin's limit settings - no model
//   3. answers through the masjid app's assistant (/api/assistant/ask), as the
//      admin, a member and a guest: roles, "I/my", rupees, the schedule
//   4. isolation: the web chat, another app, the masjid key without a user
//   5. daily limits: a lowered limit refuses, a failed answer is not counted
//   6. voice (VOICE=1): a recording through the masjid server to speech-to-text
//
// Everything is removed at the end. The model is whatever ../.env says
// (local Ollama by default; LLM_PROVIDER=groq ... to check the live setup).
//   npm run eval:masjid        (MASJID_REPO=/path/to/MasjidRahma to override)
//   ONLY=chips npm run eval:masjid   the Malayalam ready questions only (after the no-model checks)
//   ONLY=tables npm run eval:masjid   the table and chart answers only (after the no-model checks)
//   CONNECTOR=mcp npm run eval:masjid   the app registered through its MCP server (/api/ai/mcp) instead of openapi.json
//   ONLY=telegram npm run eval:masjid   the Telegram bot only (after the no-model checks), against a fake Telegram
import { spawn } from "node:child_process";
import { listMcpTools, readMcpTools, callMcpTool } from "../api/mcpTools.js";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

class OnlyDone extends Error {}

const MASJID_REPO = process.env.MASJID_REPO ?? "/Users/sinosartk/Code/Developer/work/MasjidRahma";
const MASJID_SERVER = `${MASJID_REPO}/masjid-management/server`;
if (!existsSync(`${MASJID_SERVER}/app.js`)) {
  console.error(`No masjid backend at ${MASJID_SERVER} - set MASJID_REPO.`);
  process.exit(1);
}
const apiRequire = createRequire(new URL("../api/package.json", import.meta.url));
const pg = apiRequire("pg");
const { createClient } = apiRequire("redis");
const jwt = createRequire(`${MASJID_SERVER}/package.json`)("jsonwebtoken");
const { createHmac } = await import("node:crypto");
const createHmacSync = createHmac;

const DB = `masjid_eval_${process.pid}`;
const RUN_STARTED = new Date();
const PG_ADMIN = process.env.MASJID_EVAL_PG ?? "postgres://rag:rag@localhost:5432/rag";
// Not 5060/5061: fetch refuses those ports (SIP) with "bad port".
const MASJID_PORT = 5071;
const CONNECTOR = process.env.CONNECTOR ?? "openapi";
const AI_PORT = 3016;
const M = `http://localhost:${MASJID_PORT}/api`;
const AI = `http://localhost:${AI_PORT}`;
const JWT_SECRET = randomBytes(24).toString("hex");
const MASJID_AI_TOKEN = randomBytes(24).toString("base64url");
const MASJID_ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const OTHER_ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const ADMIN_KEY = randomBytes(24).toString("base64url");
const APPS_KEY = `apps:registry:masjid-eval-${process.pid}`;

// A fake Telegram (Bot API + file downloads) for the bot's checks: it keeps
// what the bot sent, per chat. The masjid server is pointed at it.
const TG_PORT = 5082;
const TG_TOKEN = `123456:${randomBytes(16).toString("hex")}`;
const TG_SECRET = createHmacSync("sha256", TG_TOKEN).update("masjid-telegram-webhook").digest("hex");
const tgSent = [];
const tgVoice = readFileSync(new URL("./samples/voice-malayalam-rollback.m4a", import.meta.url));
const tgServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url.startsWith(`/file/bot${TG_TOKEN}/`)) return res.end(tgVoice);
    const method = req.url.split("/").pop();
    const body = raw ? JSON.parse(raw) : {};
    if (method === "sendMessage") tgSent.push(body);
    const result = method === "getMe" ? { id: 1, is_bot: true, username: "masjid_eval_bot" } : method === "getFile" ? { file_id: body.file_id, file_path: "voice/file_1.m4a" } : true;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(TG_PORT);

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += Boolean(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${String(detail).replace(/\n/g, " ").slice(0, 160)}` : ""}`);
}

async function call(url, { method = "GET", body, token, headers = {}, raw, type = "application/json" } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": type, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(600000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// --- start and stop ---
const children = [];
function start(cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
  children.push(child);
  return child;
}
async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} did not start`);
}
const admin = new pg.Client({ connectionString: PG_ADMIN });
const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });

async function cleanup() {
  for (const c of children) c.kill();
  tgServer.close();
  await sleep(500);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  } catch (err) {
    console.error(`could not drop ${DB}: ${err.message}`);
  }
  await admin.end().catch(() => {});
  try {
    await redis.del(APPS_KEY);
    for await (const keys of redis.scanIterator({ MATCH: "session:app:masjid:u-*", COUNT: 200 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) await redis.del(k);
    }
    for await (const keys of redis.scanIterator({ MATCH: "session:app:masjid:tg-*", COUNT: 200 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) await redis.del(k);
    }
    for await (const keys of redis.scanIterator({ MATCH: "session:app:masjid:g-eval-*", COUNT: 200 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) await redis.del(k);
    }
  } catch {
    // Redis down: nothing stored there
  }
  await redis.quit().catch(() => {});
}

const masjidEnv = {
  DATABASE_URL: `postgres://rag:rag@localhost:5432/${DB}`,
  JWT_SECRET,
  MASJID_AI_TOKEN,
  AI_ASK_URL: `${AI}/api/ask`,
  AI_ASK_KEY: MASJID_ASK_KEY,
  PORT: String(MASJID_PORT),
  AI_DAILY_LIMIT_MEMBER: "4",
  AI_DAILY_LIMIT_GUEST: "4",
  AI_DAILY_LIMIT_ADMIN: "0",
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_API_URL: `http://localhost:${TG_PORT}`,
};
const aiEnv = {
  APPS_KEY,
  APP_SECRETS_KEY: randomBytes(32).toString("base64"),
  ADMIN_KEY,
  APP_API_KEYS: `masjid=${MASJID_ASK_KEY},other=${OTHER_ASK_KEY}`,
  PORT: String(AI_PORT),
  ACCESS_CODE: "",
  // The per-app daily count lives in the shared local Redis: without this, a
  // few runs in one day used up the 100 and every answer became a 429.
  APP_DAILY_LIMIT: "100000",
};
const startMasjid = () => start(process.execPath, ["index.js"], MASJID_SERVER, masjidEnv);
const startAi = () => start(process.execPath, ["--env-file=../.env", "server.js"], new URL("../api/", import.meta.url).pathname, aiEnv);

// A user token as the masjid server mints it (for the direct /api/ai checks).
const AI_USER_SECRET = createHmac("sha256", JWT_SECRET).update("masjid-ai-user-token").digest("base64");
const userToken = (claims) => jwt.sign({ scope: "ai-read", ...claims }, AI_USER_SECRET, { expiresIn: "5m" });

try {
  await admin.connect();
  await redis.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  startMasjid();
  startAi();
  await waitFor(`http://localhost:${MASJID_PORT}/health`);
  await waitFor(`${AI}/api/access`);
  console.log(`Masjid backend ${MASJID_SERVER} on :${MASJID_PORT} (database ${DB}), AI service on :${AI_PORT}\n`);

  // --- made-up data, through the app's own admin routes ---
  const adminLogin = (await call(`${M}/auth/setup`, { method: "POST", body: { username: "admin", password: "eval-admin-pass" } })).body.token;
  const people = [
    ["Abdul Rasheed", 3, "monthly", 300],
    ["Fathima Beevi", 4, "monthly", 300],
    ["Muhammed Ashraf", 5, "yearly", 3000],
    ["Shameer K", 2, "monthly", 300],
    ["Paid Up Member", 3, "monthly", 100],
    // Live names are in Malayalam; people type them in English letters.
    ["സിനു ടി കെ", 3, "monthly", 200],
    // Dues since January last year, nothing paid: a past year to ask about.
    ["Old Dues Member", 2, "monthly", 100, new Date().getFullYear() - 1],
  ];
  for (const [i, [name, count, frequency, amount, startYear = 2026]] of people.entries()) {
    await call(`${M}/members`, {
      method: "POST",
      token: adminLogin,
      body: { name, address: "Eval street", phone: `900000000${i + 1}`, memberCount: count, paymentFrequency: frequency, paymentAmount: amount, duesStartYear: startYear, duesStartMonthIndex: 0, memberType: "regular" },
    });
  }
  const members = (await call(`${M}/members`)).body;
  const byName = (n) => members.find((m) => m.name === n);
  const bank = (await call(`${M}/banks`)).body[0].id;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const month = today.slice(0, 7);
  for (const t of [
    { type: "income", category: "Masjid payment", amount: 900, description: "Jan-Mar dues", date: "2026-03-05", memberId: byName("Fathima Beevi").id },
    { type: "income", category: "Masjid payment", amount: 1200, description: "2026 dues", date: "2026-03-01", memberId: byName("Paid Up Member").id },
    { type: "income", category: "Friday collection", amount: 4250, description: "Jumua collection", date: `${month}-02` },
    { type: "expense", category: "Electricity", amount: 1830, description: "KSEB bill", date: `${month}-03` },
    { type: "expense", category: "Imam salary", amount: 15000, description: "Monthly salary", date: `${month}-01` },
    // Money carried over when the books started: never counted as income by month.
    { type: "income", category: "Opening balance", amount: 50000, description: "Carried over", date: "2026-01-01" },
  ]) {
    await call(`${M}/transactions`, { method: "POST", token: adminLogin, body: { ...t, bankId: bank } });
  }
  await call(`${M}/push/announce`, { method: "POST", token: adminLogin, body: { title: "Meelad programme on Sunday", message: "Meelad programme after Maghrib on Sunday." } });
  const login = async (u, p) => (await call(`${M}/auth/login`, { method: "POST", body: { username: u, password: p } })).body.token;
  const fathima = await login(byName("Fathima Beevi").unique_id, "9000000002");
  const paidUp = await login(byName("Paid Up Member").unique_id, "9000000005");

  // --- register the app, as npm run app -- add does ---
  const reg = await call(`${AI}/api/admin/apps/masjid`, {
    method: "PUT",
    token: ADMIN_KEY,
    body: {
      name: "masjid",
      description: "Masjid management: daily food-duty rotation (which member household supplies food each day) and swaps, members, pending dues, income and expense transactions, bank balances, announcements",
      ...(CONNECTOR === "mcp" ? { mcp: `${M}/ai/mcp` } : { openapi: `${M}/ai/openapi.json` }),
      token: MASJID_AI_TOKEN,
      callers: ["masjid"],
      user: "required",
      whoami: "me",
      dataLevel: "internal",
      timezone: "Asia/Kolkata",
      timeoutMs: 60000,
    },
  });
  if (reg.status !== 200) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  console.log(`Registered masjid (${reg.body.app.kind}): ${reg.body.app.operations.length} operations\n`);

  // =====================================================================
  console.log("1. The masjid backend's AI checks (no model)");
  const svc = { Authorization: `Bearer ${MASJID_AI_TOKEN}` };
  const adminUser = userToken({ sub: "x", isAdmin: true, memberId: null });
  const memberUser = userToken({ sub: "y", isAdmin: false, memberId: byName("Fathima Beevi").id });
  const guestUser = userToken({ sub: "guest", guest: true, isAdmin: false, memberId: null });
  let r = await call(`${M}/ai/today-duty`, { headers: svc });
  check("Service token without a user: refused", r.status === 401, r.body.error);
  r = await call(`${M}/ai/today-duty`, { headers: { "X-User-Token": adminUser } });
  check("User token without the service token: refused", r.status === 401);
  r = await call(`${M}/ai/today-duty`, { headers: { ...svc, "X-User-Token": adminLogin } });
  check("A login token is not accepted as the AI user token", r.status === 401);
  r = await call(`${M}/transactions`, { method: "POST", token: adminUser, body: { type: "expense", category: "x", amount: 1 } });
  check("The AI user token cannot be used as a login (admin write refused)", r.status === 401, `status ${r.status}`);
  r = await call(`${M}/ai/finance-summary`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("A member asking for the accounts: 403 with the reason", r.status === 403 && /only the admin/.test(r.body.error), r.body.error);
  r = await call(`${M}/ai/pending-dues`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("A member's dues list is labelled as their own", r.status === 200 && /only the asking member/i.test(r.body.scope ?? "") && r.body.pending?.length === 1, r.body.scope);
  r = await call(`${M}/ai/pending-dues`, { headers: { ...svc, "X-User-Token": adminUser } });
  check("The admin's dues list: everyone owing, amounts in rupees", r.body.amountsIn?.includes("INR") && r.body.items?.length === 6, `${r.body.items?.length} owing, ${r.body.amountsIn}`);
  r = await call(`${M}/ai/pending-dues`, { headers: { ...svc, "X-User-Token": guestUser } });
  check("A guest: dues refused, 'log in'", r.status === 403 && /log in/.test(r.body.error));
  const fathimaDue = (await call(`${M}/ai/me`, { headers: { ...svc, "X-User-Token": memberUser } })).body.dues?.due;
  check("A member's own record (/ai/me): role and dues", fathimaDue > 0, `due ${fathimaDue}`);
  const sinu = byName("സിനു ടി കെ");
  const shortId = sinu.unique_id.replace(/^MR#0*/, "MR");
  r = await call(`${M}/ai/pending-dues?search=${encodeURIComponent("Sinu TK")}`, { headers: { ...svc, "X-User-Token": adminUser } });
  check('"Sinu TK" finds the Malayalam-named member (pending dues)', r.body.membersFound?.[0]?.id === sinu.unique_id && r.body.pending?.length === 1, JSON.stringify(r.body.membersFound));
  r = await call(`${M}/ai/pending-dues?search=${encodeURIComponent("Sinu TK")}`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("pending-dues: a member searching another member - refused, not \"no pending dues\"", r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await call(`${M}/ai/finance-by-month?startDate=2026-01-01&endDate=2026-12-31`, { headers: { ...svc, "X-User-Token": adminUser } });
  const fm = (k) => r.body.months?.find((m) => m.month === k);
  check("finance-by-month: 12 months, March 2100 in, this month 4250 in / 16830 out, opening balance left out and named", r.body.months?.length === 12 && fm("2026-03")?.income === 2100 && fm(month)?.income === 4250 && fm(month)?.expense === 16830 && fm("2026-01")?.income === 0 && r.body.openingBalancesLeftOut === 50000, JSON.stringify(r.body).slice(0, 200));
  r = await call(`${M}/ai/finance-by-month`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("finance-by-month: refused to a member", r.status === 403, r.status);
  r = await call(`${M}/ai/finance-by-month?startDate=2023-01-01&endDate=2026-12-31`, { headers: { ...svc, "X-User-Token": adminUser } });
  check("finance-by-month: more than 24 months refused", r.status === 400, `${r.status} ${r.body.error ?? ""}`);
  r = await call(`${M}/ai/members?search=${encodeURIComponent("sinu t k")}`, { headers: { ...svc, "X-User-Token": adminUser } });
  check('"sinu t k" (spaced initials) finds them too', r.body.items?.length === 1 && r.body.items[0].id === sinu.unique_id, r.body.items?.map((m) => m.nameInEnglishLetters).join(", "));
  r = await call(`${M}/ai/members?search=${encodeURIComponent(shortId)}`, { headers: { ...svc, "X-User-Token": adminUser } });
  check(`A short member id ("${shortId}") finds them`, r.body.items?.[0]?.id === sinu.unique_id);
  r = await call(`${M}/ai/members?search=${encodeURIComponent("Zubair Xyz")}`, { headers: { ...svc, "X-User-Token": adminUser } });
  check("A name that matches nobody: said so, with every name in English letters", /No member name matched/.test(r.body.noMatch ?? "") && r.body.allMembers?.some((m) => m.nameInEnglishLetters === "sinu ti ke"), r.body.noMatch);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const tomorrowDuty = (await call(`${M}/ai/duty-on-date?date=${tomorrow}`, { headers: { ...svc, "X-User-Token": guestUser } })).body.member?.name;
  const todayDuty = (await call(`${M}/ai/today-duty`, { headers: { ...svc, "X-User-Token": guestUser } })).body.member?.name;
  check("A guest: the duty schedule is open", Boolean(todayDuty && tomorrowDuty), `today ${todayDuty}, tomorrow ${tomorrowDuty}`);

  // =====================================================================
  console.log("\n1b. The masjid MCP server, /api/ai/mcp (no model)");
  const mcpUrl = `${M}/ai/mcp`;
  const { tools } = await listMcpTools(mcpUrl, { token: MASJID_AI_TOKEN, timeoutMs: 10000 });
  const spec = (await call(`${M}/ai/openapi.json`, { headers: svc })).body;
  const opIds = Object.values(spec.paths).map((p) => p.get.operationId);
  check("Tools listed without a user: one per endpoint, same names as openapi.json, all read-only", tools.length === opIds.length && opIds.every((id) => tools.some((t) => t.name === id)) && tools.every((t) => t.annotations?.readOnlyHint === true), `${tools.length} tools`);
  const mcpOps = readMcpTools(tools).operations;
  const tool = (id) => mcpOps.find((o) => o.id === id);
  const mcpApp = { name: "masjid", baseUrl: mcpUrl, timeoutMs: 10000 };
  const mcpCall = (id, args, userToken) => callMcpTool(mcpApp, tool(id), args, { token: MASJID_AI_TOKEN, userToken, maxChars: 100000 });
  r = await mcpCall("today_duty", {});
  check("A tool call without a user: refused", !r.ok && /user token is required/.test(r.error), r.error);
  r = await callMcpTool(mcpApp, tool("today_duty"), {}, { token: "wrong", userToken: guestUser, maxChars: 1000 });
  check("Wrong service token: refused", !r.ok && /refused this service.s access/.test(r.error), r.error);
  r = await mcpCall("today_duty", {}, guestUser);
  check("A guest: today's duty, the same as the HTTP endpoint", r.ok && JSON.parse(r.text).member?.name === todayDuty, r.text?.slice(0, 80));
  r = await mcpCall("pending_dues", {}, guestUser);
  check("A guest: dues refused with 'log in'", !r.ok && /log in/.test(r.error), r.error);
  r = await mcpCall("finance_summary", {}, memberUser);
  check("A member asking for the accounts: the reason passed on", !r.ok && /only the admin/.test(r.error), r.error);
  r = await mcpCall("pending_dues", {}, adminUser);
  check("The admin's dues list: everyone owing", r.ok && JSON.parse(r.text).items?.length === 6);
  r = await mcpCall("dues_by_year", { year: String(Number(today.slice(0, 4)) - 1), everyone: "true" }, adminUser);
  check("Integer and boolean arguments (dues_by_year, everyone=true)", r.ok && JSON.parse(r.text).membersWithAPlan >= 1, r.shown);
  r = await mcpCall("members", { search: "Sinu TK" }, adminUser);
  check('"Sinu TK" finds the Malayalam-named member through MCP too', r.ok && JSON.parse(r.text).items?.[0]?.id === sinu.unique_id);
  r = await call(mcpUrl, { headers: svc });
  check("GET on the MCP endpoint: 405 (stateless, POST only)", r.status === 405);

  // =====================================================================
  console.log("\n1c. Personal MCP tokens for Claude Code (no model)");
  r = await call(`${M}/admin/mcp-tokens`, { method: "POST", token: fathima, body: { name: "member's laptop" } });
  check("A member cannot make one", r.status === 403);
  r = await call(`${M}/admin/mcp-tokens`, { method: "POST", token: adminLogin, body: { name: "Claude Code eval" } });
  const personal = r.body.token;
  check("The admin makes one: mcp_..., shown once", r.status === 201 && /^mcp_[A-Za-z0-9_-]{40,}$/.test(personal ?? ""), `${r.status} ...${r.body.hint}`);
  r = await call(`${M}/admin/mcp-tokens`, { token: adminLogin });
  check("Listed by name and last 4 characters, never the token", r.body.tokens?.length === 1 && r.body.tokens[0].hint === personal.slice(-4) && !JSON.stringify(r.body).includes(personal));
  const asClaude = (id, args = {}) => callMcpTool(mcpApp, tool(id), args, { token: personal, maxChars: 100000 });
  const listed = await listMcpTools(mcpUrl, { token: personal, timeoutMs: 10000 }).catch((e) => ({ tools: [], error: e.message }));
  check("With the personal token alone: the tools are listed", listed.tools.length === opIds.length, listed.error ?? `${listed.tools.length} tools`);
  r = await asClaude("pending_dues");
  check("A tool call answers as the admin: everyone owing", r.ok && JSON.parse(r.text).items?.length === 6, r.error ?? "");
  r = await asClaude("finance_summary");
  check("The admin's accounts too", r.ok && JSON.parse(r.text).totalExpense > 0, r.error ?? "");
  // The official MCP client (SDK), as Claude Code connects: only the Authorization header.
  const { Client } = await import("../examples/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StreamableHTTPClientTransport } = await import("../examples/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js");
  const sdk = new Client({ name: "eval-as-claude-code", version: "1.0.0" });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${personal}` } } }));
    const sdkTools = (await sdk.listTools()).tools;
    const res = await sdk.callTool({ name: "members", arguments: { search: "Sinu TK" } });
    check("The official MCP client (as Claude Code): tools listed, a tool called", sdkTools.length === opIds.length && JSON.parse(res.content[0].text).items?.[0]?.id === sinu.unique_id, `${sdkTools.length} tools, server ${sdk.getServerVersion()?.name}`);
  } catch (err) {
    check("The official MCP client (as Claude Code): tools listed, a tool called", false, err.message);
  } finally {
    await sdk.close().catch(() => {});
  }
  r = await call(`${M}/ai/today-duty`, { token: personal });
  check("The personal token opens /api/ai/mcp only, not the other /api/ai endpoints", r.status === 401, r.body.error);
  r = await call(`${M}/admin/assistant-settings`, { token: personal });
  check("It is not a login (admin route refused)", r.status === 401);
  r = await call(`${M}/admin/mcp-tokens`, { token: adminLogin });
  check("Last used is recorded", Boolean(r.body.tokens?.[0]?.lastUsedAt));
  r = await callMcpTool(mcpApp, tool("today_duty"), {}, { token: `mcp_${randomBytes(32).toString("base64url")}`, maxChars: 1000 });
  check("An unknown mcp_ token: refused", !r.ok && /unknown or revoked/.test(r.error), r.error);
  r = await call(`${M}/admin/mcp-tokens/${encodeURIComponent((await call(`${M}/admin/mcp-tokens`, { token: adminLogin })).body.tokens[0].id)}`, { method: "DELETE", token: adminLogin });
  const afterRevoke = await callMcpTool({ ...mcpApp, name: "masjid-revoked" }, tool("today_duty"), {}, { token: personal, maxChars: 1000 });
  check("Revoked: refused from the next request", r.status === 200 && !afterRevoke.ok && /unknown or revoked/.test(afterRevoke.error), afterRevoke.error);

  // =====================================================================
  console.log("\n2. The admin's limit settings (no model)");
  r = await call(`${M}/admin/assistant-settings`, { token: adminLogin });
  check("Defaults: members 4, guests 4, admin no limit", JSON.stringify(r.body.dailyLimits) === JSON.stringify({ admin: 0, member: 4, guest: 4 }), JSON.stringify(r.body.dailyLimits));
  r = await call(`${M}/admin/assistant-settings`, { method: "PUT", token: fathima, body: { dailyLimits: { member: 50 } } });
  check("A member cannot change them", r.status === 403);
  r = await call(`${M}/admin/assistant-settings`, { method: "PUT", body: { dailyLimits: { member: 50 } } });
  check("A guest cannot change them", r.status === 401);
  r = await call(`${M}/admin/assistant-settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 101 } } });
  check("Out of range refused", r.status === 400);
  r = await call(`${M}/admin/assistant-settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 6 } } });
  const st = (await call(`${M}/assistant/status`, { token: fathima })).body;
  check("A change applies at once", st.limit === 6 && st.askingAs?.role === "member", JSON.stringify(st));
  await call(`${M}/admin/assistant-settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 20, guest: 20 } } });

  // =====================================================================
  console.log("\n3. Answers through the masjid app's assistant");
  const ask = async (token, question, chatId) => {
    const t = Date.now();
    const res = await call(`${M}/assistant/ask`, { method: "POST", token, body: { question, chatId: chatId ?? (token ? `eval${t}` : `eval-guest-${t}-${randomBytes(4).toString("hex")}`) } });
    return { ...res, answer: res.body.answer ?? res.body.error ?? "", sources: (res.body.sources ?? []).map((s) => s.source), ms: Date.now() - t };
  };
  const plain = (s) => s.replace(/,/g, "");
  // A past year's dues (found by the user: "my pending of last year" got no answer).
  const lastYear = new Date().getFullYear() - 1;
  const oldMember = userToken({ sub: "z", isAdmin: false, memberId: byName("Old Dues Member").id });
  r = await call(`${M}/ai/dues-by-year?year=${lastYear}`, { headers: { ...svc, "X-User-Token": oldMember } });
  const od = r.body.members?.[0];
  check(`dues-by-year: a member's own ${lastYear} - 12 months missed, ₹1200 due`, od?.due === 1200 && od?.missedMonths?.length === 12, JSON.stringify(od ?? r.body).slice(0, 160));
  r = await call(`${M}/ai/dues-by-year?year=${lastYear}&search=${encodeURIComponent("Old Dues Member")}`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("dues-by-year: another member's year refused to a member", r.status === 403, `${r.status} ${r.body.error ?? ""}`);
  // Found live: the admin's "pending of last year" was a 400 (the admin is not one member).
  r = await call(`${M}/ai/dues-by-year?year=${lastYear}`, { headers: { ...svc, "X-User-Token": adminUser } });
  const oy = r.body.members?.find((x) => x.name === "Old Dues Member");
  check(`dues-by-year: the admin, no member named - everyone still owing for ${lastYear}`, r.status === 200 && oy?.due === 1200 && r.body.totalDue >= 1200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  r = await call(`${M}/ai/dues-by-year?year=${lastYear}&everyone=true`, { headers: { ...svc, "X-User-Token": memberUser } });
  check("dues-by-year: everyone=true refused to a member", r.status === 403, `${r.status} ${r.body.error ?? ""}`);
  const show = (a) => `${(a.ms / 1000).toFixed(1)}s ${a.answer.slice(0, 120)}`;
  const oldLogin = await login(byName("Old Dues Member").unique_id, "9000000007");
  // The assistant's ready questions in Malayalam (the chips in the masjid app's
  // AssistantChat.tsx - keep the same words): each must reach the right data.
  // Names may come back in Malayalam letters, so amounts and sources are checked.
  let a;

  // =====================================================================
  // The masjid assistant as a Telegram bot (masjid server/telegram.js), against
  // the fake Telegram above: linking, roles, then answers.
  if (!process.env.ONLY || process.env.ONLY === "telegram") {
    console.log("\n3b. The Telegram bot");
    let updateId = 1000;
    // One update to the webhook; the bot's next `expect` messages to that chat.
    const tg = async (fromId, message, { expect = 1, chatType = "private", id = ++updateId, secret = TG_SECRET } = {}) => {
      const chatId = fromId;
      const before = tgSent.filter((m) => m.chat_id === chatId).length;
      const res = await fetch(`${M}/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
        body: JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatType }, from: { id: fromId, is_bot: false, first_name: "Eval" }, ...message } }),
      });
      const t = Date.now();
      const deadline = t + (expect ? 180000 : 2500);
      let got = [];
      while (Date.now() < deadline) {
        got = tgSent.filter((m) => m.chat_id === chatId).slice(before);
        if (expect && got.length >= expect) break;
        await sleep(150);
      }
      const text = got.map((m) => m.text).join("\n---\n");
      return { status: res.status, got, text, plainText: text.replace(/<[^>]+>/g, "").replace(/,/g, ""), ms: Date.now() - t };
    };
    const MEMBER_TG = 7001;
    const ADMIN_TG = 7002;
    const GUEST_TG = 7003;
    let t = await tg(MEMBER_TG, { text: "/start" }, { secret: "wrong", expect: 0 });
    check("Webhook: a wrong secret is refused", t.status === 401 && t.got.length === 0, t.status);
    t = await tg(MEMBER_TG, { text: "/start" });
    check("/start (not linked): welcome with a share-phone button", /Assalamu alaikum/.test(t.text) && t.got[0]?.reply_markup?.keyboard?.[0]?.[0]?.request_contact === true, t.text);
    t = await tg(MEMBER_TG, { contact: { phone_number: "+919000000002", user_id: 9999 } });
    check("Someone else's contact card: refused", /your own number/.test(t.text), t.text);
    t = await tg(GUEST_TG, { contact: { phone_number: "+918888888888", user_id: GUEST_TG } });
    check("A number not on the member list: not linked", /not on the masjid's member list/.test(t.text), t.text);
    t = await tg(MEMBER_TG, { contact: { phone_number: "+91 90000 00002", user_id: MEMBER_TG } });
    check("Own phone number: linked as that member", /Linked/.test(t.text) && t.text.includes(byName("Fathima Beevi").unique_id), t.text);
    const dupId = ++updateId;
    t = await tg(MEMBER_TG, { text: "/whoami" }, { id: dupId });
    check("/whoami: the member", t.text.includes(`member ${byName("Fathima Beevi").unique_id}`), t.text);
    t = await tg(MEMBER_TG, { text: "/whoami" }, { id: dupId, expect: 0 });
    check("The same update again (Telegram retry): not answered twice", t.status === 200 && t.got.length === 0, `${t.got.length} messages`);
    t = await tg(MEMBER_TG, { text: "/whoami" }, { chatType: "group", expect: 0 });
    check("A group chat: no answer (everyone would see it)", t.got.length === 0, `${t.got.length} messages`);
    r = await call(`${M}/telegram/link-code`, { method: "POST" });
    check("A link code needs a login", r.status === 401, r.status);
    r = await call(`${M}/telegram/link-code`, { method: "POST", token: adminLogin });
    const code = new URL(r.body.url ?? "https://x").searchParams.get("start");
    check("The admin makes a link: t.me/<bot>?start=<code>", r.status === 201 && r.body.url?.startsWith("https://t.me/masjid_eval_bot?start=l_"), r.body.url ?? r.body.error);
    t = await tg(ADMIN_TG, { text: `/start ${code}` });
    check("Opening it links the Telegram account as the admin", /Linked/.test(t.text) && /the admin/.test(t.text), t.text);
    t = await tg(GUEST_TG, { text: `/start ${code}` });
    check("The same link a second time: refused", /expired or was already used/.test(t.text), t.text);
    r = await call(`${M}/telegram/link`, { token: adminLogin });
    check("The admin's Settings shows the link", r.body.available === true && r.body.links?.length === 1 && r.body.botUsername === "masjid_eval_bot", JSON.stringify(r.body));
    r = await call(`${M}/telegram/admin`, { token: fathima });
    check("The bot's admin status: not for a member", r.status === 403, r.status);
    t = await tg(GUEST_TG, { text: "/voice english" });
    check("/voice english: saved", /read as English/.test(t.text), t.text);

    // With a model
    t = await tg(MEMBER_TG, { text: "How much do I still have to pay?" });
    check("Member over Telegram: own pending amount, with the source", t.plainText.includes(String(fathimaDue)) && /Source: masjid API/.test(t.text), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(MEMBER_TG, { text: "Show me Abdul Rasheed's dues" });
    const abdulDue = (await call(`${M}/ai/pending-dues`, { headers: { ...svc, "X-User-Token": adminUser } })).body.items?.find((x) => x.name === "Abdul Rasheed")?.due;
    check("Member over Telegram: another member's dues refused, not \"owes nothing\"", !t.plainText.includes(String(abdulDue)) && !/no pending|does not have any|doesn't have any|owes nothing|fully paid/i.test(t.plainText) && /admin/i.test(t.plainText), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(ADMIN_TG, { text: "Which members have pending dues?" });
    check("Admin over Telegram: everyone's dues", ["Abdul", "Fathima"].every((x) => t.text.includes(x)), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(GUEST_TG, { text: "Which members have pending dues?" });
    check("Guest over Telegram: dues refused", !t.text.includes("Fathima") && !t.plainText.includes(String(fathimaDue)), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(GUEST_TG, { text: "Who supplies food today?" });
    check("Guest over Telegram: today's food duty answered", /Source: masjid API/.test(t.text) && !/log in/i.test(t.text), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    if (process.env.VOICE === "1") {
      await tg(MEMBER_TG, { text: "/voice malayalam" });
      t = await tg(MEMBER_TG, { voice: { file_id: "v1", duration: 4, mime_type: "audio/mp4" } }, { expect: 2 });
      check("A voice note: Malayalam text shown back, then answered", /🎙/.test(t.got[0]?.text ?? "") && /[ഀ-ൿ]/.test(t.got[0]?.text ?? "") && t.got.length >= 2, t.text.slice(0, 200));
    }
    t = await tg(MEMBER_TG, { text: "/unlink" });
    t = await tg(MEMBER_TG, { text: "/whoami" });
    check("/unlink: a guest again", /a guest/.test(t.text), t.text);
    if (process.env.ONLY === "telegram") throw new OnlyDone();
  }

  // 10d.11: tables and charts. The masjid server asks with display { tables, charts };
  // every figure in the table or chart must be the API's own.
  if (!process.env.ONLY || process.env.ONLY === "tables") {
    const owing = (await call(`${M}/ai/pending-dues`, { headers: { ...svc, "X-User-Token": adminUser } })).body.items;
    const mdTable = (text) => {
      const lines = text.split("\n");
      const i = lines.findIndex((l, k) => /^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[k + 1] ?? ""));
      if (i < 0) return null;
      const rows = [];
      for (let k = i + 2; k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k]); k++) rows.push(lines[k].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      return rows;
    };
    const num = (x) => Number(String(x).replace(/[^\d.-]/g, ""));
    const chatT = `evaltables${Date.now()}`;
    a = await ask(adminLogin, "Which members have pending dues? Show them as a table.", chatT);
    const rows = mdTable(a.answer) ?? [];
    const figuresMatch = owing.every((o) => rows.some((r) => r.some((c) => num(c) === o.due)));
    check("Table: the admin's pending dues as a Markdown table, every member and amount from the API", rows.length >= owing.length && figuresMatch, `${rows.length} rows for ${owing.length} owing | ${show(a)}`);
    a = await ask(adminLogin, "show that as a bar chart", chatT);
    const block = a.answer.match(/```\s*chart\s*\n([\s\S]*?)```/)?.[1];
    let chart = null;
    try {
      chart = JSON.parse(block ?? "");
    } catch {
      // checked below
    }
    const values = (chart?.data ?? []).map((d) => Number(d.value)).sort((x, y) => x - y).join();
    const expected = owing.map((o) => o.due).sort((x, y) => x - y).join();
    check('Chart: "show that as a bar chart" - a valid chart block with the same figures', ["bar", "pie", "line"].includes(chart?.type) && values === expected, `${chart?.type ?? "no chart"} [${values}] vs [${expected}]`);
    a = await ask(adminLogin, "Who supplies food today?");
    check("One fact: a sentence, no table or chart", !mdTable(a.answer) && !/```\s*chart/.test(a.answer), show(a));
    // Found by the user: "last year's income as a line chart" and "income vs expense" drew nothing -
    // finance_summary has one total per range, no months, and a chart had one series only.
    // The seeded data: March 2100 in, 0 out; this month 4250 in, 16830 out.
    const chartOf = (text) => {
      try {
        return JSON.parse(text.match(/```\s*chart\s*\n([\s\S]*?)```/)?.[1] ?? "");
      } catch {
        return null;
      }
    };
    a = await ask(adminLogin, "Show this year's income month by month as a line chart.");
    let c = chartOf(a.answer);
    const incomes = (c?.data ?? []).map((d) => Number(d.value ?? d.Income ?? d.income));
    const labels = (c?.data ?? []).map((d) => d.label).join(", ");
    check("Line chart: this year's income by month - March ₹2100 and this month ₹4250, no opening balance, nothing invented, no 2025 months", c?.type === "line" && incomes.includes(2100) && incomes.includes(4250) && incomes.every((v) => [0, 2100, 4250].includes(v)) && !/2025/.test(labels), `${c?.type ?? "no chart"} [${incomes}] ${labels} | ${show(a)}`);
    a = await ask(adminLogin, "Compare income vs expense month by month this year in a chart.");
    c = chartOf(a.answer);
    // As the masjid chat reads it: "series", or else the first item's keys.
    const names = c?.series ?? Object.keys(c?.data?.[0] ?? {}).filter((k) => k !== "label");
    const inKey = names.find((n) => /income/i.test(n));
    const outKey = names.find((n) => /expense/i.test(n));
    const thisMonth = (c?.data ?? []).find((d) => Number(d[inKey]) === 4250);
    const march = (c?.data ?? []).find((d) => Number(d[inKey]) === 2100);
    check("Income vs expense: one chart, two series, every month's figures from the API", Boolean(inKey && outKey && thisMonth && Number(thisMonth[outKey]) === 16830 && march && Number(march[outKey] ?? 0) === 0), `${JSON.stringify(c ?? "no chart").slice(0, 200)} | ${show(a)}`);
    if (process.env.ONLY === "tables") throw new OnlyDone();
  }

  // ONLY=chips stops after these - to check them on Groq without using up its quota.
  a = await ask(adminLogin, "ഈ മാസം ഇതുവരെ എത്ര ചെലവായി, ഏതൊക്കെ ഇനങ്ങളിൽ?");
  check("Chip (admin, Malayalam): this month's spending", plain(a.answer).includes("16830") && a.sources.includes("masjid API"), show(a));
  a = await ask(adminLogin, "വരിസംഖ്യ അടയ്ക്കാൻ ബാക്കിയുള്ള അംഗങ്ങൾ ആരൊക്കെ, എത്ര വീതം?");
  check("Chip (admin, Malayalam): members with pending dues", plain(a.answer).includes(String(fathimaDue)) && a.sources.includes("masjid API"), show(a));
  a = await ask(adminLogin, "കഴിഞ്ഞ വർഷത്തെ വരിസംഖ്യ ബാക്കിയുള്ളവർ ആരൊക്കെ?");
  check("Chip (admin, Malayalam): last year's pending - everyone", plain(a.answer).includes("1200") && a.sources.includes("masjid API"), show(a));
  a = await ask(fathima, "എനിക്ക് അടയ്ക്കാൻ ബാക്കിയുള്ള തുക എത്ര?");
  check("Chip (member, Malayalam): my pending amount", plain(a.answer).includes(String(fathimaDue)) && a.sources.includes("masjid API"), show(a));
  a = await ask(oldLogin, "കഴിഞ്ഞ വർഷം എനിക്ക് അടയ്ക്കാൻ ബാക്കിയുണ്ടായിരുന്നോ?");
  check("Chip (member, Malayalam): my pending last year", plain(a.answer).includes("1200") && a.sources.includes("masjid API"), show(a));
  a = await ask(null, "ഇന്ന് ഭക്ഷണം നൽകുന്നത് ആരാണ്?");
  check("Chip (guest, Malayalam): today's food duty", a.sources.includes("masjid API") && !/log in|ലോഗിൻ/i.test(a.answer), show(a));
  if (process.env.ONLY === "chips") throw new OnlyDone();
  a = await ask(adminLogin, "Which members have pending dues and how much?");
  check("Admin: everyone's dues", ["Abdul", "Fathima", "Ashraf", "Shameer"].every((x) => a.answer.includes(x)) && a.sources.includes("masjid API"), show(a));
  check("Admin: amounts in rupees, not dollars", /₹|INR|rupee/i.test(a.answer) && !a.answer.includes("$"), show(a));
  a = await ask(adminLogin, "How much did the masjid spend this month?");
  check("Admin: the accounts", plain(a.answer).includes("16830"), show(a));
  a = await ask(fathima, "Which members have pending dues?");
  check("Member: only their own dues, nobody else's", a.answer.includes("Fathima") && !["Abdul", "Ashraf", "Shameer"].some((x) => a.answer.includes(x)), show(a));
  a = await ask(paidUp, "Which members have pending dues?");
  // Found live: "no members have pending dues" to a member whose own list was
  // empty. The answer must say it is about them (or that the admin sees all).
  check(
    "Paid-up member: told it is about their own dues, not that nobody owes",
    /\badmin\b|your own|you (do not|don't|have no)|you have not|you owe nothing|no pending dues for you|you are (fully )?paid/i.test(a.answer),
    a.answer.slice(0, 260)
  );
  a = await ask(fathima, "Do I have any pending dues?");
  check("Member: 'Do I have dues?' answered for them", /\byes\b|you(, [^,]{1,40},)? have|you owe/i.test(a.answer) && plain(a.answer).includes(String(fathimaDue)), show(a));
  a = await ask(oldLogin, "What were my pending dues for last year?");
  check("Member: 'my pending for last year' - that year's dues, not just this year's", plain(a.answer).includes("1200") && a.sources.includes("masjid API"), show(a));
  a = await ask(adminLogin, "What were the pending dues of last year?");
  check("Admin: 'pending dues of last year' - the members who still owe for that year", a.answer.includes("Old Dues Member") && plain(a.answer).includes("1200") && a.sources.includes("masjid API"), show(a));
  a = await ask(fathima, "When is my next food duty?");
  check("Member: 'my next duty' - a date", /\d{4}-\d{2}-\d{2}|January|February|March|April|May|June|July|August|September|October|November|December/.test(a.answer), show(a));
  a = await ask(fathima, "How much did the masjid spend this month?");
  check("Member: the accounts are not told", !plain(a.answer).includes("16830") && !plain(a.answer).includes("15000"), show(a));
  a = await ask(adminLogin, "What are the pending dues of Sinu TK?");
  check('Admin: "dues of Sinu TK" - the Malayalam-named member, with the amount', (a.answer.includes("സിനു") || /sinu/i.test(a.answer)) && /₹|INR|rupee/i.test(a.answer) && !/no (member|record|dues) found|not found|couldn.t find/i.test(a.answer), show(a));
  a = await ask(adminLogin, "When is Sinu TK on food duty this month?");
  // "this month" needs today's date in the answer step too - it listed January.
  const thisMonth = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  check('Admin: "Sinu TK duty days this month" - this month\'s dates, not "no duty found"', a.answer.includes(thisMonth) && !/no (duty|member|record)s? found|not found|couldn.t find/i.test(a.answer), show(a));
  a = await ask(null, "Who supplies food today?");
  check("Guest: today's duty", a.answer.includes(todayDuty.split(" ")[0]), show(a));
  a = await ask(null, "Who is on food duty tomorrow?");
  check("Guest: tomorrow's duty", a.answer.includes(tomorrowDuty.split(" ")[0]), show(a));
  a = await ask(null, "Which members have pending dues?");
  check("Guest: dues refused, asked to log in", /log in|login/i.test(a.answer) && !["Abdul", "Shameer"].some((x) => a.answer.includes(x)), show(a));
  a = await ask(null, "What is the capital of France?");
  check("Guest: not a general chatbot", !a.answer.includes("Paris"), show(a));
  r = await call(`${M}/assistant/ask`, { method: "POST", body: { question: "Who supplies food today?", chatId: "main" } });
  check("Guest with a guessable chat id: refused", r.status === 400);

  // =====================================================================
  console.log("\n4. Nobody else sees masjid data");
  const stream = await (await fetch(`${AI}/api/chat/stream?${new URLSearchParams({ q: "Who supplies food today at the masjid?", sessionId: `eval-web-${Date.now()}`, mode: "single" })}`)).text();
  check("The web chat: no masjid call", !stream.includes("connected_app") && !stream.includes("masjid API"));
  r = await call(`${AI}/api/ask`, { method: "POST", token: OTHER_ASK_KEY, body: { question: "Which masjid members have pending dues?" } });
  check("Another app's key: no masjid data", r.status === 200 && !(r.body.sources ?? []).some((s) => s.source === "masjid API"), r.body.answer);
  r = await call(`${AI}/api/ask`, { method: "POST", token: MASJID_ASK_KEY, body: { question: "Who supplies food today?" } });
  check("The masjid key without a user: no masjid data", r.status === 200 && !(r.body.sources ?? []).some((s) => s.source === "masjid API"), r.body.answer);

  // Phase 10e: the AI service's usage dashboard sees who asked - a member code
  // or an anonymous visitor code, never a name.
  r = await call(`${AI}/api/admin/usage?days=1`, { token: ADMIN_KEY });
  const refs = (r.body.byUser ?? []).filter((u) => u.caller === "masjid" && new Date(u.last_at) >= RUN_STARTED).map((u) => u.user_ref);
  check(
    "Usage dashboard: members by code, visitors anonymous, no names",
    refs.some((u) => /^member:[A-Za-z0-9_.-]+$/.test(u)) && refs.some((u) => /^guest:[0-9a-f]{10}$/.test(u)) && !refs.some((u) => /fathima|shameer|sinu/i.test(u)),
    refs.join(", ")
  );

  // =====================================================================
  console.log("\n5. Daily limits");
  await call(`${M}/admin/assistant-settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 1 } } });
  const fresh = await login(byName("Shameer K").unique_id, "9000000004");
  a = await ask(fresh, "Who supplies food today?");
  check("Limit 1: the first question is answered, 0 left", a.status === 200 && a.body.remaining === 0, `remaining ${a.body.remaining}`);
  a = await ask(fresh, "Who is on duty tomorrow?");
  check("…the second is refused, and says so", a.status === 429 && a.body.remaining === 0, a.body.error);
  await call(`${M}/admin/assistant-settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 20 } } });
  const before = (await call(`${M}/assistant/status`, { token: fathima })).body.remaining;
  children[1].kill(); // the AI service goes away
  await sleep(800);
  a = await ask(fathima, "Who supplies food today?");
  const after = (await call(`${M}/assistant/status`, { token: fathima })).body.remaining;
  check("AI service down: an error, and the question is not counted", a.status === 502 && after === before, `${a.status}, ${before} -> ${after} left`);
  children[1] = startAi();
  await waitFor(`${AI}/api/access`);

  // =====================================================================
  if (process.env.VOICE === "1") {
    console.log("\n6. Voice");
    const audio = readFileSync(new URL("./samples/voice-malayalam-rollback.m4a", import.meta.url));
    r = await call(`${M}/assistant/transcribe?lang=Malayalam`, { method: "POST", token: fathima, raw: audio, type: "audio/mp4" });
    check("A Malayalam recording through the masjid server becomes Malayalam text", r.status === 200 && /[ഀ-ൿ]/.test(r.body.text ?? ""), r.body.text ?? r.body.error);
  }
} catch (err) {
  if (!(err instanceof OnlyDone)) {
    console.error(`\nStopped: ${err.message}`);
    total++;
  }
} finally {
  await cleanup();
}
console.log(`\n${passed}/${total} passed.`);
process.exit(passed === total ? 0 : 1);
