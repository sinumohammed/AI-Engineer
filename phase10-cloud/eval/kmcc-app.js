// The KMCC app end to end, on this Mac, with made-up data - never the live
// database. Starts the KMCC backend from its own repo (KMCC_REPO) against a
// throwaway Postgres database (its Prisma migrations applied), and this
// service's API next to it; fills the database through the app's own admin
// routes; registers the app; then asks:
//
//   1. the KMCC backend's AI checks: service token, user token, roles,
//      dues worked out, names in Malayalam, the MCP server - no model
//   2. the admin's limit settings - no model
//   3. the Telegram bot against a fake Telegram: linking, refusals, answers
//   4. answers through the app's assistant (/api/assistant/ask), as the admin
//      and members: the Malayalam ready questions, roles, a table and a chart
//   5. isolation: the web chat, another app, the KMCC key without a user
//   6. daily limits: a lowered limit refuses, a failed answer is not counted
//
// Everything is removed at the end. The model is whatever ../.env says
// (local Ollama by default; LLM_PROVIDER=groq ... to check the live setup).
//   npm run eval:kmcc        (KMCC_REPO=/path/to/kmcc-jeddah to override)
//   ONLY=telegram npm run eval:kmcc   the Telegram bot only (after the no-model checks)
//   ONLY=chips npm run eval:kmcc      the Malayalam ready questions only (after the no-model checks)
//   DETAIL=1 npm run eval:kmcc        failures in full (the whole answer)
//   CONNECTOR=mcp npm run eval:kmcc   the app registered through its MCP server (/api/ai/mcp) instead of openapi.json
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { listMcpTools, readMcpTools, callMcpTool } from "../api/mcpTools.js";

class OnlyDone extends Error {}

const KMCC_REPO = process.env.KMCC_REPO ?? "/Users/sinosartk/Code/Developer/work/kmcc-jeddah";
const KMCC_SERVER = `${KMCC_REPO}/server`;
if (!existsSync(`${KMCC_SERVER}/src/ai/routes.ts`)) {
  console.error(`No KMCC backend with the assistant at ${KMCC_SERVER} - set KMCC_REPO.`);
  process.exit(1);
}
const apiRequire = createRequire(new URL("../api/package.json", import.meta.url));
const pg = apiRequire("pg");
const { createClient } = apiRequire("redis");
const jwt = createRequire(`${KMCC_SERVER}/package.json`)("jsonwebtoken");

const DB = `kmcc_eval_${process.pid}`;
const RUN_STARTED = new Date();
const PG_ADMIN = process.env.KMCC_EVAL_PG ?? "postgres://rag:rag@localhost:5432/rag";
const DB_URL = `postgres://rag:rag@localhost:5432/${DB}`;
const KMCC_PORT = 5073;
const CONNECTOR = process.env.CONNECTOR ?? "openapi";
const AI_PORT = 3017;
const K = `http://localhost:${KMCC_PORT}/api`;
const AI = `http://localhost:${AI_PORT}`;
const JWT_SECRET = randomBytes(24).toString("hex");
const KMCC_AI_TOKEN = randomBytes(24).toString("base64url");
const KMCC_ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const OTHER_ASK_KEY = `ak_${randomBytes(18).toString("base64url")}`;
const ADMIN_KEY = randomBytes(24).toString("base64url");
const APPS_KEY = `apps:registry:kmcc-eval-${process.pid}`;
const SOURCE = "kmcc API";

// A fake Telegram (Bot API) for the bot's checks: it keeps what the bot sent, per chat.
const TG_PORT = 5083;
const TG_TOKEN = `123456:${randomBytes(16).toString("hex")}`;
const TG_SECRET = createHmac("sha256", TG_TOKEN).update("kmcc-telegram-webhook").digest("hex");
const tgSent = [];
const tgServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    const body = raw ? JSON.parse(raw) : {};
    if (method === "sendMessage") tgSent.push(body);
    const result = method === "getMe" ? { id: 1, is_bot: true, username: "kmcc_eval_bot" } : true;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(TG_PORT);

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += Boolean(ok);
  // DETAIL=1: a failure's detail in full (the answer), not its first 160 characters.
  const shown = !ok && process.env.DETAIL === "1" ? String(detail) : String(detail).replace(/\n/g, " ").slice(0, 160);
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${shown}` : ""}`);
}

async function call(url, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  for (let i = 0; i < 90; i++) {
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
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } catch (err) {
    console.error(`could not drop ${DB}: ${err.message}`);
  }
  await admin.end().catch(() => {});
  try {
    await redis.del(APPS_KEY);
    for await (const keys of redis.scanIterator({ MATCH: "session:app:kmcc:u-*", COUNT: 200 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) await redis.del(k);
    }
  } catch {
    // Redis down: nothing stored there
  }
  await redis.quit().catch(() => {});
}

const dbEnv = { DATABASE_URL: DB_URL, DIRECT_URL: DB_URL };
const kmccEnv = {
  ...dbEnv,
  JWT_SECRET,
  KMCC_AI_TOKEN,
  AI_ASK_URL: `${AI}/api/ask`,
  AI_ASK_KEY: KMCC_ASK_KEY,
  PORT: String(KMCC_PORT),
  AI_DAILY_LIMIT_MEMBER: "4",
  AI_DAILY_LIMIT_ADMIN: "0",
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_API_URL: `http://localhost:${TG_PORT}`,
};
const aiEnv = {
  APPS_KEY,
  APP_SECRETS_KEY: randomBytes(32).toString("base64"),
  ADMIN_KEY,
  APP_API_KEYS: `kmcc=${KMCC_ASK_KEY},other=${OTHER_ASK_KEY}`,
  PORT: String(AI_PORT),
  ACCESS_CODE: "",
  APP_DAILY_LIMIT: "100000",
};
// The TypeScript server, as `npm run dev` runs it but without the watcher.
const startKmcc = () => start(process.execPath, ["-r", "ts-node/register/transpile-only", "src/server.ts"], KMCC_SERVER, { ...kmccEnv, TS_NODE_PROJECT: "tsconfig.json" });
const startAi = () => start(process.execPath, ["--env-file=../.env", "server.js"], new URL("../api/", import.meta.url).pathname, aiEnv);

// A user token as the KMCC server mints it (ai/aiUser.ts), for the direct /api/ai checks.
const AI_USER_SECRET = createHmac("sha256", JWT_SECRET).update("kmcc-ai-user-token").digest("base64");
const userToken = (m, isAdmin = false) => jwt.sign({ sub: m.id, code: m.memberCode, isAdmin, scope: "ai-read" }, AI_USER_SECRET, { expiresIn: "5m" });

try {
  await admin.connect();
  await redis.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "../prisma/schema.prisma"], { cwd: KMCC_SERVER, env: { ...process.env, ...dbEnv }, stdio: "ignore" });
  execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", "src/seed.ts"], { cwd: KMCC_SERVER, env: { ...process.env, ...dbEnv }, stdio: "ignore" });
  startKmcc();
  startAi();
  await waitFor(`${K}/health`);
  await waitFor(`${AI}/api/access`);
  console.log(`KMCC backend ${KMCC_SERVER} on :${KMCC_PORT} (database ${DB}), AI service on :${AI_PORT}\n`);

  // --- made-up data, through the app's own admin routes ---
  const login = async (username, password) => (await call(`${K}/auth/login`, { method: "POST", body: { username, password } })).body;
  const adminAuth = await login("KMCC0001", "admin123");
  const adminLogin = adminAuth.token;
  const y = new Date().getFullYear();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());
  const thisMonth = Number(today.slice(5, 7));
  const mk = async (b) => (await call(`${K}/members`, { method: "POST", token: adminLogin, body: { password: "eval-pass-1", ...b } })).body;
  // A Saudi mobile (05...) - Telegram sends it as +9665...
  const basheer = await mk({ name: "BASHEER.P", mobile: "0501234567", isSavingMember: true, joinDate: `${y}-01-05`, monthlyAmount: 500 });
  const shareef = await mk({ name: "SHAREEF.KP", mobile: "0507654321", isSavingMember: true, joinDate: `${y - 1}-06-01`, monthlyAmount: 1000 });
  const mujeeb = await mk({ name: "MUJEEB K", mobile: "0505555555", isLoanMember: true, joinDate: `${y - 1}-01-01` });
  const favas = await mk({ name: "FAVAS TK", mobile: "9876543210", isSavingMember: true, joinDate: `${y}-01-01`, monthlyAmount: 200 });
  await call(`${K}/members/${shareef.id}/monthly-amount`, { method: "POST", token: adminLogin, body: { year: y, amount: 1000 } });
  const bank = (await call(`${K}/banks`, { method: "POST", token: adminLogin, body: { name: "SBI Neerad", openingBalance: 100000 } })).body;
  const tx = async (b) => {
    const r = await call(`${K}/transactions`, { method: "POST", token: adminLogin, body: b });
    if (r.status !== 201) throw new Error(`transaction: ${r.status} ${JSON.stringify(r.body)}`);
  };
  const mid = (m) => `${y}-${String(m).padStart(2, "0")}-10T09:00:00Z`;
  await tx({ memberId: basheer.id, date: `${y}-02-10T09:00:00Z`, flow: "INCOME", category: "SAVING_DEPOSIT", amount: 1500, description: "Jan-Mar" });
  await tx({ memberId: shareef.id, date: `${y - 1}-07-01T09:00:00Z`, flow: "INCOME", category: "SAVING_DEPOSIT", amount: 3000, description: "Jun-Aug" });
  // Shareef: every month of this year paid - the paid-up member.
  await tx({ memberId: shareef.id, date: mid(thisMonth), flow: "INCOME", category: "SAVING_DEPOSIT", amount: 1000 * thisMonth, description: "This year" });
  await tx({ memberId: favas.id, date: mid(1), flow: "INCOME", category: "SAVING_DEPOSIT", amount: 200 });
  // Found live: a member's profit credited and withdrawals were answered wrongly.
  await tx({ memberId: basheer.id, date: mid(6), flow: "INCOME", category: "PROFIT", amount: 300, description: "Profit share" });
  await tx({ memberId: basheer.id, date: mid(7), flow: "EXPENSE", category: "SAVING_WITHDRAWAL", amount: 200, description: "Withdrawal" });
  // As KMCC's real books (imported from the old sheets): last year's opening
  // balance and profit entered under Saving, told apart only by the description.
  await tx({ memberId: favas.id, date: `${y - 1}-12-31T09:00:00Z`, flow: "INCOME", category: "SAVING_DEPOSIT", amount: 5000, description: `opening balance ${y - 1}` });
  await tx({ memberId: favas.id, date: `${y - 1}-12-31T09:00:00Z`, flow: "INCOME", category: "SAVING_DEPOSIT", amount: 700, description: `Profit ${y - 1}` });
  await tx({ memberId: mujeeb.id, bankId: bank.id, date: `${y}-03-01T09:00:00Z`, flow: "EXPENSE", category: "LOAN_DISBURSEMENT", amount: 20000, description: "Loan" });
  const loanId = (await call(`${K}/loans?memberId=${mujeeb.id}`, { token: adminLogin })).body[0].id;
  await tx({ memberId: mujeeb.id, bankId: bank.id, date: `${y}-05-01T09:00:00Z`, flow: "INCOME", category: "LOAN_REPAYMENT", amount: 5000, linkedLoanId: loanId });
  await tx({ bankId: bank.id, date: mid(thisMonth), flow: "EXPENSE", category: "EXPENSE", amount: 750, description: "Iftar" });
  await tx({ bankId: bank.id, date: mid(thisMonth), flow: "EXPENSE", category: "ZAKAT", amount: 2000, description: "Zakat paid" });
  const basheerLogin = (await login(basheer.memberCode, "eval-pass-1")).token;
  const shareefLogin = (await login(shareef.memberCode, "eval-pass-1")).token;
  const mujeebLogin = (await login(mujeeb.memberCode, "eval-pass-1")).token;

  // --- register the app, as npm run app -- add does ---
  const reg = await call(`${AI}/api/admin/apps/kmcc`, {
    method: "PUT",
    token: ADMIN_KEY,
    body: {
      name: "kmcc",
      description: "KMCC Jeddah savings and loan scheme: members, monthly savings dues (paid and pending months), savings deposits and withdrawals, loans and repayments, profit, interest, zakat, expenses and bank balances",
      ...(CONNECTOR === "mcp" ? { mcp: `${K}/ai/mcp` } : { openapi: `${K}/ai/openapi.json` }),
      token: KMCC_AI_TOKEN,
      callers: ["kmcc"],
      user: "required",
      whoami: "me",
      dataLevel: "internal",
      timezone: "Asia/Riyadh",
      timeoutMs: 60000,
    },
  });
  if (reg.status !== 200) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  console.log(`Registered kmcc (${reg.body.app.kind}): ${reg.body.app.operations.length} operations\n`);

  // =====================================================================
  console.log("1. The KMCC backend's AI checks (no model)");
  const svc = { Authorization: `Bearer ${KMCC_AI_TOKEN}` };
  const adminUser = userToken(adminAuth.member, true);
  const basheerUser = userToken(basheer);
  const as = (u) => ({ headers: { ...svc, "X-User-Token": u } });
  let r = await call(`${K}/ai/me`, { headers: svc });
  check("Service token without a user: refused", r.status === 401, r.body.error);
  r = await call(`${K}/ai/me`, { headers: { "X-User-Token": adminUser } });
  check("User token without the service token: refused", r.status === 401);
  r = await call(`${K}/ai/me`, as(adminLogin));
  check("A login token is not accepted as the AI user token", r.status === 401);
  r = await call(`${K}/members`, { token: adminUser });
  check("The AI user token cannot be used as a login", r.status === 401, `status ${r.status}`);
  for (const p of ["/totals", "/banks", "/members", "/flow-by-category", "/finance-by-day"]) {
    r = await call(`${K}/ai${p}`, as(basheerUser));
    check(`A member asking for ${p}: 403 with the reason`, r.status === 403 && /only the admin/.test(r.body.error), r.body.error);
  }
  r = await call(`${K}/ai/transactions?search=shareef`, as(basheerUser));
  check("A member searching another member's transactions: refused", r.status === 403, `${r.status} ${r.body.error ?? ""}`);
  r = await call(`${K}/ai/transactions`, as(basheerUser));
  check("A member's transactions: only their own, labelled so", r.status === 200 && r.body.matching === 3 && /only the asking member/i.test(r.body.scope ?? "") && !r.body.transactions[0].member, JSON.stringify(r.body).slice(0, 160));
  r = await call(`${K}/ai/dues`, as(basheerUser));
  const bDues = r.body.dues?.[0];
  check(`A member's own dues: Jan-Mar paid, Apr-${today.slice(5, 7)} pending at ₹500`, bDues?.monthsPaid === 3 && bDues?.pendingAmount === 500 * (thisMonth - 3) && r.body.amountsIn?.includes("INR"), JSON.stringify(bDues ?? r.body).slice(0, 160));
  const basheerPending = bDues?.pendingAmount;
  r = await call(`${K}/ai/pending-dues`, as(adminUser));
  const pend = (m) => r.body.pending?.find((p) => p.member.code === m.memberCode);
  check("The admin's pending dues: Basheer and Favas owe, Shareef is paid up", pend(basheer)?.pendingAmount === basheerPending && pend(favas)?.pendingAmount === 200 * (thisMonth - 1) && !pend(shareef) && r.body.membersPaidUp === 1, JSON.stringify(r.body).slice(0, 200));
  r = await call(`${K}/ai/pending-dues?year=${y - 1}`, as(adminUser));
  check(`Last year (${y - 1}): Shareef owes Sep-Dec, ₹4000`, r.body.pending?.length === 1 && r.body.pending[0].member.code === shareef.memberCode && r.body.pending[0].pendingAmount === 4000, JSON.stringify(r.body.pending ?? r.body).slice(0, 160));
  r = await call(`${K}/ai/loans`, as(adminUser));
  check("Loans: Mujeeb ₹20000, ₹15000 still owed", r.body.loans?.[0]?.balance === 15000 && r.body.loans[0].repaid === 5000 && r.body.totalBalance === 15000, JSON.stringify(r.body.loans ?? r.body).slice(0, 160));
  r = await call(`${K}/ai/totals`, as(adminUser));
  const totals = r.body;
  check("Totals: the dashboard's figures (bank 100000 - 20000 + 5000 - 750 - 2000 = 82250)", r.body.totalBankBalance === 82250 && r.body.totalLoansOutstanding === 15000, JSON.stringify(r.body).slice(0, 200));
  r = await call(`${K}/ai/member-summary?search=${encodeURIComponent("ബഷീർ")}`, as(adminUser));
  check('Malayalam "ബഷീർ" finds BASHEER.P', r.body.members?.[0]?.member.code === basheer.memberCode, JSON.stringify(r.body).slice(0, 120));
  const bs = r.body.members?.[0];
  check("A member's account as on the Profile statement: contributed 1500, profit 300, withdrawn 200, savings 1600, credit 1800 - debit 200 = balance 1600", bs?.savings.contributed === 1500 && bs.savings.withdrawn === 200 && bs.savings.savingsBalance === 1600 && bs.savings.profitCredited === 300 && bs.statement.totalCredit === 1800 && bs.statement.totalDebit === 200 && bs.statement.balance === 1600, JSON.stringify({ savings: bs?.savings, statement: bs?.statement }).slice(0, 200));
  const thisYear = bs?.byYear?.find((x) => x.year === y);
  check(`Year by year: ${y} deposited 1500, profit 300, withdrawn 200; the largest entries carry their descriptions`, thisYear?.contributed === 1500 && thisYear.profitCredited === 300 && thisYear.withdrawn === 200 && bs.largestEntries?.[0]?.amount === 1500 && bs.largestEntries[0].description === "Jan-Mar", JSON.stringify({ byYear: bs?.byYear, top: bs?.largestEntries?.[0] }).slice(0, 200));
  r = await call(`${K}/ai/member-summary?search=${encodeURIComponent("favas t k")}`, as(adminUser));
  check('"favas t k" (spaced initials) finds FAVAS TK', r.body.members?.length === 1 && r.body.members[0].member.code === favas.memberCode);
  const fs = r.body.members?.[0]?.savings;
  const fLast = r.body.members?.[0]?.byYear?.find((x) => x.year === y - 1);
  check(`Profit and opening balance entered under Saving are read from the description: opening 5000, profit 700 (${y - 1}), contributed 200, savings 5900`, fs?.openingBalance === 5000 && fs.profitCredited === 700 && fs.contributed === 200 && fs.savingsBalance === 5900 && fLast?.profitCredited === 700 && fLast.openingBalance === 5000 && fLast.contributed === 0, JSON.stringify({ fs, fLast }).slice(0, 200));
  r = await call(`${K}/ai/member-summary?search=${encodeURIComponent(`kmcc ${Number(mujeeb.memberCode.slice(4))}`)}`, as(adminUser));
  check("A short member code finds them", r.body.members?.[0]?.member.code === mujeeb.memberCode, JSON.stringify(r.body).slice(0, 120));
  r = await call(`${K}/ai/member-summary?search=${encodeURIComponent("Zubair Xyz")}`, as(adminUser));
  check("A name that matches nobody: said so, with every member listed", /No member matched/.test(r.body.noMatch ?? "") && r.body.allMembers?.length >= 4, r.body.noMatch);
  r = await call(`${K}/ai/member-summary?search=${encodeURIComponent("Zubair Xyz")}`, as(basheerUser));
  // Found on Groq over MCP: the model passed "my" as the search, and Mujeeb heard "no loan".
  check("…to a member: their own record (a member only ever sees themselves), nobody listed", !r.body.allMembers && r.body.members?.length === 1 && r.body.members[0].member.code === basheer.memberCode, JSON.stringify(r.body).slice(0, 120));
  r = await call(`${K}/ai/loans?search=${encodeURIComponent("എന്റെ")}`, as(userToken(mujeeb)));
  check('A member\'s loans with "എന്റെ" (my) as the search: their own loan, not "no record"', r.body.loans?.length === 1 && r.body.loans[0].balance === 15000, JSON.stringify(r.body).slice(0, 120));
  r = await call(`${K}/ai/finance-by-month`, as(basheerUser));
  check("finance-by-month: a member gets only their own (Feb ₹1500 in, ₹1800 in the year with profit)", r.status === 200 && r.body.totalIn === 1800 && r.body.items?.find((x) => x.month.startsWith("Feb"))?.in === 1500, JSON.stringify(r.body).slice(0, 160));

  console.log("\n1b. The KMCC MCP server, /api/ai/mcp (no model)");
  const mcpUrl = `${K}/ai/mcp`;
  const { tools } = await listMcpTools(mcpUrl, { token: KMCC_AI_TOKEN, timeoutMs: 10000 });
  const spec = (await call(`${K}/ai/openapi.json`, { headers: svc })).body;
  const opIds = Object.values(spec.paths).map((p) => p.get.operationId);
  check("Tools listed without a user: one per endpoint, all read-only", tools.length === opIds.length && opIds.every((id) => tools.some((t) => t.name === id)) && tools.every((t) => t.annotations?.readOnlyHint === true), `${tools.length} tools`);
  const mcpOps = readMcpTools(tools).operations;
  const mcpApp = { name: "kmcc", baseUrl: mcpUrl, timeoutMs: 10000 };
  const mcpCall = (id, args, u) => callMcpTool(mcpApp, mcpOps.find((o) => o.id === id), args, { token: KMCC_AI_TOKEN, userToken: u, maxChars: 100000 });
  r = await mcpCall("totals", {});
  check("A tool call without a user: refused", !r.ok && /user token is required/.test(r.error), r.error);
  r = await mcpCall("totals", {}, basheerUser);
  check("A member asking for the totals: the reason passed on", !r.ok && /only the admin/.test(r.error), r.error);
  r = await mcpCall("pending_dues", { year: String(y - 1) }, adminUser);
  check("An integer argument (pending_dues, last year)", r.ok && JSON.parse(r.text).pending?.[0]?.pendingAmount === 4000, r.text?.slice(0, 100));

  // =====================================================================
  console.log("\n2. The admin's limit settings (no model)");
  r = await call(`${K}/assistant/settings`, { token: adminLogin });
  check("Defaults: members 4, admin no limit", JSON.stringify(r.body.dailyLimits) === JSON.stringify({ member: 4, admin: 0 }), JSON.stringify(r.body.dailyLimits));
  r = await call(`${K}/assistant/settings`, { method: "PUT", token: basheerLogin, body: { dailyLimits: { member: 50 } } });
  check("A member cannot change them", r.status === 403);
  r = await call(`${K}/assistant/settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 101 } } });
  check("Out of range refused", r.status === 400);
  r = await call(`${K}/assistant/settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 6 } } });
  const st = (await call(`${K}/assistant/status`, { token: basheerLogin })).body;
  check("A change applies at once", st.limit === 6 && st.askingAs?.role === "member" && st.askingAs?.memberCode === basheer.memberCode, JSON.stringify(st));
  r = await call(`${K}/assistant/status`);
  check("No login: no assistant", r.status === 401);
  await call(`${K}/assistant/settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 40 } } });

  const ask = async (token, question, chatId) => {
    const t = Date.now();
    const res = await call(`${K}/assistant/ask`, { method: "POST", token, body: { question, chatId: chatId ?? `eval${t}` } });
    return { ...res, answer: res.body.answer ?? res.body.error ?? "", sources: (res.body.sources ?? []).map((s) => s.source), ms: Date.now() - t };
  };
  // "82,250" and "82 250" (a space as the thousands separator, as Groq wrote it) -> "82250".
  const plain = (s) => s.replace(/,/g, "").replace(/(\d)[ \u00a0\u202f](?=\d{3}\b)/g, "$1");
  const show = (a) => `${(a.ms / 1000).toFixed(1)}s ${process.env.DETAIL === "1" ? a.answer : a.answer.slice(0, 120)}`;
  let a;

  // =====================================================================
  if (!process.env.ONLY || process.env.ONLY === "telegram") {
    console.log("\n3. The Telegram bot");
    let updateId = 1000;
    const tg = async (fromId, message, { expect = 1, chatType = "private", id = ++updateId, secret = TG_SECRET } = {}) => {
      const before = tgSent.filter((m) => m.chat_id === fromId).length;
      const res = await fetch(`${K}/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
        body: JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: chatType }, from: { id: fromId, is_bot: false, first_name: "Eval" }, ...message } }),
      });
      const t = Date.now();
      const deadline = t + (expect ? 180000 : 2500);
      let got = [];
      while (Date.now() < deadline) {
        got = tgSent.filter((m) => m.chat_id === fromId).slice(before);
        if (expect && got.length >= expect) break;
        await sleep(150);
      }
      const text = got.map((m) => m.text).join("\n---\n");
      return { status: res.status, got, text, plainText: text.replace(/<[^>]+>/g, "").replace(/,/g, ""), ms: Date.now() - t };
    };
    const MEMBER_TG = 8001;
    const ADMIN_TG = 8002;
    const STRANGER_TG = 8003;
    let t = await tg(MEMBER_TG, { text: "/start" }, { secret: "wrong", expect: 0 });
    check("Webhook: a wrong secret is refused", t.status === 401 && t.got.length === 0, t.status);
    t = await tg(MEMBER_TG, { text: "/start" });
    check("/start (not linked): how to link, with a share-phone button", /not linked/.test(t.text) && t.got[0]?.reply_markup?.keyboard?.[0]?.[0]?.request_contact === true, t.text);
    t = await tg(STRANGER_TG, { text: "What is the total bank balance?" });
    check("A question from an account that is not linked: not answered, told how to link", /not linked/.test(t.text) && !t.plainText.includes(String(totals.totalBankBalance)), t.text);
    t = await tg(MEMBER_TG, { contact: { phone_number: "+966501234567", user_id: 9999 } });
    check("Someone else's contact card: refused", /your own number/.test(t.text), t.text);
    t = await tg(STRANGER_TG, { contact: { phone_number: "+966511111111", user_id: STRANGER_TG } });
    check("A number not on the member list: not linked", /not on KMCC's member list/.test(t.text), t.text);
    t = await tg(MEMBER_TG, { contact: { phone_number: "+966 50 123 4567", user_id: MEMBER_TG } });
    check("Own Saudi number (+966 5..., 05... on the record): linked as that member", /Linked/.test(t.text) && t.text.includes(basheer.memberCode), t.text);
    const dupId = ++updateId;
    t = await tg(MEMBER_TG, { text: "/whoami" }, { id: dupId });
    check("/whoami: the member", t.text.includes(basheer.memberCode), t.text);
    t = await tg(MEMBER_TG, { text: "/whoami" }, { id: dupId, expect: 0 });
    check("The same update again (Telegram retry): not answered twice", t.status === 200 && t.got.length === 0, `${t.got.length} messages`);
    t = await tg(MEMBER_TG, { text: "/whoami" }, { chatType: "group", expect: 0 });
    check("A group chat: no answer", t.got.length === 0, `${t.got.length} messages`);
    r = await call(`${K}/telegram/link-code`, { method: "POST" });
    check("A link code needs a login", r.status === 401, r.status);
    r = await call(`${K}/telegram/link-code`, { method: "POST", token: adminLogin });
    const code = new URL(r.body.url ?? "https://x").searchParams.get("start");
    check("The admin makes a link: t.me/<bot>?start=<code>", r.status === 201 && r.body.url?.startsWith("https://t.me/kmcc_eval_bot?start=l_"), r.body.url ?? r.body.error);
    t = await tg(ADMIN_TG, { text: `/start ${code}` });
    check("Opening it links the Telegram account as the admin", /Linked/.test(t.text) && /the admin/.test(t.text), t.text);
    t = await tg(STRANGER_TG, { text: `/start ${code}` });
    check("The same link a second time: refused", /expired or was already used/.test(t.text), t.text);
    r = await call(`${K}/telegram/admin`, { token: basheerLogin });
    check("The bot's admin status: not for a member", r.status === 403, r.status);

    // With a model
    t = await tg(MEMBER_TG, { text: "How much do I still have to pay this year?" });
    check("Member over Telegram: own pending amount, with the source", t.plainText.includes(String(basheerPending)) && /Source: kmcc API/.test(t.text), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(MEMBER_TG, { text: "What is KMCC's total bank balance?" });
    check("Member over Telegram: the totals refused", !t.plainText.includes(String(totals.totalBankBalance)), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(ADMIN_TG, { text: "Who has an active loan and how much is left?" });
    check("Admin over Telegram: the loans", /MUJEEB/i.test(t.text) && t.plainText.includes("15000"), `${(t.ms / 1000).toFixed(1)}s ${t.plainText.slice(0, 140)}`);
    t = await tg(MEMBER_TG, { text: "/unlink" });
    t = await tg(MEMBER_TG, { text: "/whoami" });
    check("/unlink: not linked any more", /not linked/.test(t.text), t.text);
    if (process.env.ONLY === "telegram") throw new OnlyDone();
  }

  // =====================================================================
  // The ready questions in Malayalam (AssistantChat.tsx - keep the same
  // words): each must reach the right data. Names may come back in Malayalam
  // letters, so amounts and sources are checked.
  console.log("\n4. Answers through the KMCC app's assistant");
  a = await ask(basheerLogin, "എന്റെ സേവിംഗ്സ് ബാലൻസ് എത്രയാണ്?");
  check("Chip (member, Malayalam): my savings balance ₹1600 (1500 contributed + 300 profit - 200 withdrawn)", plain(a.answer).includes("1600") && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, "How much has BASHEER.P saved in total, how much profit was credited to him, and how much has he withdrawn?");
  check("Admin: one member's savings 1500, profit 300, withdrawn 200", ["1500", "300", "200"].every((n) => plain(a.answer).includes(n)) && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, `Show ${shareef.memberCode}'s savings deposited each year.`);
  check(`Admin: a member's deposits year by year - ${y - 1}: 3000, ${y}: ${1000 * thisMonth}`, plain(a.answer).includes("3000") && plain(a.answer).includes(String(1000 * thisMonth)) && a.answer.includes(String(y - 1)) && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, `${favas.memberCode} - how much has he contributed, how much profit has he earned, and what is his current total savings?`);
  check("Admin: profit entered under Saving still counted as profit - contributed 200, profit 700, savings 5900", ["200", "700", "5900"].every((n) => plain(a.answer).includes(n)) && a.sources.includes(SOURCE), show(a));
  a = await ask(basheerLogin, "എനിക്ക് ഇതുവരെ എത്ര ലാഭം ക്രെഡിറ്റ് ചെയ്തു?");
  check("Member (Malayalam): profit credited to me ₹300", plain(a.answer).includes("300") && a.sources.includes(SOURCE), show(a));
  a = await ask(basheerLogin, "ഈ വർഷം ഞാൻ ഏതൊക്കെ മാസങ്ങൾ അടയ്ക്കാനുണ്ട്, ആകെ എത്ര?");
  check(`Chip (member, Malayalam): my pending months, ₹${basheerPending}`, plain(a.answer).includes(String(basheerPending)) && a.sources.includes(SOURCE), show(a));
  a = await ask(mujeebLogin, "എന്റെ ലോൺ ബാക്കി എത്രയാണ്?");
  check("Chip (member, Malayalam): my loan balance ₹15000", plain(a.answer).includes("15000") && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, "ഈ വർഷം മാസവരി അടയ്ക്കാൻ ബാക്കിയുള്ള അംഗങ്ങൾ ആരൊക്കെ, എത്ര വീതം?");
  check("Chip (admin, Malayalam): members with pending dues", plain(a.answer).includes(String(basheerPending)) && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, "കഴിഞ്ഞ വർഷത്തെ മാസവരി ബാക്കിയുള്ളവർ ആരൊക്കെ?");
  check("Chip (admin, Malayalam): last year's pending - Shareef ₹4000", plain(a.answer).includes("4000") && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, "ബാങ്ക് അക്കൗണ്ടുകളിലെ ഇപ്പോഴത്തെ ബാലൻസ് എത്ര?");
  check("Chip (admin, Malayalam): bank balance ₹82250", plain(a.answer).includes("82250") && a.sources.includes(SOURCE), show(a));
  if (process.env.ONLY === "chips") throw new OnlyDone();
  a = await ask(basheerLogin, "Which members have pending dues?");
  check("Member: only their own dues, nobody else's", !/FAVAS|SHAREEF/i.test(a.answer), show(a));
  a = await ask(basheerLogin, "How much has Shareef saved?");
  check("Member: another member's savings refused", !plain(a.answer).includes(String(1000 * thisMonth + 3000)) && /admin|only|own|cannot|can't|not able/i.test(a.answer), show(a));
  a = await ask(basheerLogin, "What is the total bank balance of KMCC?");
  check("Member: the totals are not told", !plain(a.answer).includes("82250"), show(a));
  a = await ask(shareefLogin, "Do I have any pending dues this year?");
  check("Paid-up member: told they owe nothing this year", /no pending|nothing|fully paid|all paid|paid up|up to date|no dues|have paid|0\b|₹0/i.test(a.answer) && a.sources.includes(SOURCE), show(a));
  a = await ask(adminLogin, "Which members have pending dues this year, and how much? Show them as a table.");
  check("Admin: pending dues as a table, in rupees", /^\s*\|.*\|\s*$/m.test(a.answer) && /BASHEER|ബഷീർ/i.test(a.answer) && plain(a.answer).includes(String(basheerPending)) && !a.answer.includes("$"), show(a));
  a = await ask(adminLogin, "What is the capital of France?");
  check("Admin: not a general chatbot", !a.answer.includes("Paris"), show(a));

  // =====================================================================
  console.log("\n5. Nobody else sees KMCC data");
  const stream = await (await fetch(`${AI}/api/chat/stream?${new URLSearchParams({ q: "What is the KMCC bank balance?", sessionId: `eval-web-${Date.now()}`, mode: "single" })}`)).text();
  check("The web chat: no KMCC call", !stream.includes(SOURCE));
  r = await call(`${AI}/api/ask`, { method: "POST", token: OTHER_ASK_KEY, body: { question: "Which KMCC members have pending dues?" } });
  check("Another app's key: no KMCC data", r.status === 200 && !(r.body.sources ?? []).some((s) => s.source === SOURCE), r.body.answer);
  r = await call(`${AI}/api/ask`, { method: "POST", token: KMCC_ASK_KEY, body: { question: "What is the total bank balance?" } });
  check("The KMCC key without a user: no KMCC data", r.status === 200 && !(r.body.sources ?? []).some((s) => s.source === SOURCE), r.body.answer);
  r = await call(`${AI}/api/admin/usage?days=1`, { token: ADMIN_KEY });
  const refs = (r.body.byUser ?? []).filter((u) => u.caller === "kmcc" && new Date(u.last_at) >= RUN_STARTED).map((u) => u.user_ref);
  check("Usage dashboard: members by code, the admin as admin, no names", refs.some((u) => /^member:KMCC\d+$/.test(u)) && refs.includes("admin") && !refs.some((u) => /basheer|mujeeb|shareef/i.test(u)), refs.join(", "));

  // =====================================================================
  console.log("\n6. Daily limits");
  await call(`${K}/assistant/settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 1 } } });
  const favasLogin = (await login(favas.memberCode, "eval-pass-1")).token;
  a = await ask(favasLogin, "What is my savings balance?");
  check("Limit 1: the first question is answered, 0 left", a.status === 200 && a.body.remaining === 0, `remaining ${a.body.remaining}`);
  a = await ask(favasLogin, "Which months are pending?");
  check("…the second is refused, and says so", a.status === 429 && a.body.remaining === 0, a.body.error);
  await call(`${K}/assistant/settings`, { method: "PUT", token: adminLogin, body: { dailyLimits: { member: 40 } } });
  const before = (await call(`${K}/assistant/status`, { token: basheerLogin })).body.remaining;
  children[1].kill(); // the AI service goes away
  await sleep(800);
  a = await ask(basheerLogin, "What is my savings balance?");
  const after = (await call(`${K}/assistant/status`, { token: basheerLogin })).body.remaining;
  check("AI service down: an error, and the question is not counted", a.status === 502 && after === before, `${a.status}, ${before} -> ${after} left`);
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
