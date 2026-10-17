// Phase 10 #4 (10d.9): connected apps over MCP (api/mcpTools.js) - the demo
// hall data from examples/demo-mcp (official MCP SDK) wrapping
// examples/demo-app, started here:
//   4041 demo app, 4042 the same answering slowly
//   4043 MCP stateless, 4044 MCP with sessions, 4046 MCP over the slow app
//   1. registration: tools read, only read-only ones, token encrypted, bad entries refused - no model
//   2. calls: typed arguments, the user passed on, refusals, sessions, time limit - no model
//   3. answers (ANSWERS=1): planner + agent on the same questions as eval:apps (MODES=single,multi; ONLY=<text>)
// Uses its own registry key and a throwaway encryption key, so the real registry is untouched.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

process.env.APPS_KEY = "apps:registry:eval-mcp";
process.env.APP_SECRETS_KEY = randomBytes(32).toString("base64");
const { saveApp, removeApp, getApp, refreshApp } = await import("../api/appRegistry.js");
const { callOperation, checkPlan, appContext: appContextRaw } = await import("../api/apps.js");
const { describeOperation } = await import("../api/openapiTools.js");
const { withAccess } = await import("../api/appAccess.js");
const asEval = (fn, userToken) => withAccess({ caller: "eval", userToken }, fn);
const appContext = (q) => asEval(() => appContextRaw(q));
const { redis } = await import("../api/sessionStore.js");

const DEMO_APP = new URL("../examples/demo-app/server.js", import.meta.url).pathname;
const DEMO_MCP = new URL("../examples/demo-mcp/server.js", import.meta.url).pathname;
const children = new Map();
function start(name, file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  children.set(name, child);
  return new Promise((resolve) => child.stdout.once("data", resolve));
}
const stop = () => children.forEach((c) => c.kill());
process.on("exit", stop);

let passed = 0;
let total = 0;
function check(label, ok, detail = "") {
  total++;
  passed += Boolean(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` - ${detail}` : ""}`);
}
async function refused(fn, pattern) {
  try {
    await fn();
    return "accepted";
  } catch (err) {
    return pattern.test(err.message) ? true : err.message;
  }
}

const sessionsServer = () => start("mcp-sessions", DEMO_MCP, { DEMO_MCP_PORT: "4044", DEMO_MCP_SESSIONS: "1", DEMO_APP_URL: "http://localhost:4041/api" });
await start("app", DEMO_APP, { DEMO_APP_PORT: "4041" });
await start("app-slow", DEMO_APP, { DEMO_APP_PORT: "4042", DEMO_APP_DELAY_MS: "3000" });
await start("mcp", DEMO_MCP, { DEMO_MCP_PORT: "4043", DEMO_APP_URL: "http://localhost:4041/api" });
await sessionsServer();
await start("mcp-slow", DEMO_MCP, { DEMO_MCP_PORT: "4046", DEMO_APP_URL: "http://localhost:4042/api" });
await redis.del(process.env.APPS_KEY);

const HALL = {
  name: "hall",
  description: "Community hall (demo data): volunteer duty roster by day, members, monthly dues paid or pending, announcements",
  mcp: "http://localhost:4043/mcp",
  token: "demo-token",
  dataLevel: "internal",
  timezone: "Asia/Kolkata",
  timeoutMs: 10000,
  callers: ["eval"],
  user: "optional",
  whoami: "me",
};

console.log("1. Registration");
const { app, skipped } = await saveApp(HALL);
check("Tools read: 7 read-only tools, add_announcement (not read-only) left out", app.operations.length === 7 && skipped.notReadOnly === 1 && !app.operations.some((o) => o.tool === "add_announcement"), app.operations.map((o) => o.id).join(", "));
check('Stored as kind "mcp", calls go to the server URL', app.kind === "mcp" && app.baseUrl === "http://localhost:4043/mcp" && !("openapi" in app), `${app.kind}, ${app.baseUrl}`);
check("Tool arguments read from the input schema", JSON.stringify(app.operations.find((o) => o.id === "announcements").params.map((p) => [p.name, p.type, p.required])) === '[["limit","integer",false]]');
check("Required arguments and enums kept", JSON.stringify(app.operations.find((o) => o.id === "duty_schedule").params.map((p) => p.required)) === "[true,true]" && app.operations.find((o) => o.id === "list_dues").params[0].enum?.join() === "pending,paid");
const raw = await redis.hGet(process.env.APPS_KEY, "hall");
check("Token stored encrypted, not shown", !raw.includes("demo-token") && app.hasToken && !("tokenEnc" in app));
check("Wrong token: refused at registration", (await refused(() => saveApp({ ...HALL, name: "hall-bad", token: "wrong" }), /401.*check the token/)) === true);
check("Both openapi and mcp: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", openapi: "http://localhost:4041/api/ai/openapi.json" }), /one of the two/)) === true);
check("Neither: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", mcp: undefined }), /one of the two/)) === true);
check("http to another machine: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", mcp: "http://example.com/mcp" }), /must use https/)) === true);
check("whoami naming no read-only tool: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", whoami: "add_announcement" }), /whoami.*read-only tools/)) === true);
check("Not an MCP server: refused with a clear message", (await refused(() => saveApp({ ...HALL, name: "hall-x", mcp: "http://localhost:4043/other" }), /could not read the MCP server's tools: 404/)) === true);
const limited = await saveApp({ ...HALL, name: "hall-limited", whoami: undefined, allow: ["duty_on_date", "list_dues", "add_announcement"] });
check('"allow" keeps only the listed tools - and still only read-only ones', limited.app.operations.map((o) => o.id).join() === "duty_on_date,list_dues" && limited.skipped.notAllowed === 5);
await removeApp("hall-limited");
const refreshed = await refreshApp("hall");
check("Refresh reads the tools again, keeps kind and token", refreshed.app.kind === "mcp" && refreshed.app.operations.length === 7 && refreshed.app.hasToken);
check("The planner's line for a tool", describeOperation("hall", app.operations.find((o) => o.id === "duty_schedule")) === "hall.duty_schedule - tool - The duty roster for a range of days (at most 31). Params: from (string, required): First day, YYYY-MM-DD; to (string, required): Last day, YYYY-MM-DD");

console.log("\n2. Calls");
const hall = await getApp("hall");
const op = (id) => hall.operations.find((o) => o.id === id);
const one = await callOperation(hall, op("announcements"), { limit: "1" });
check('An integer argument goes as a number ("1" -> 1 announcement)', one.ok && JSON.parse(one.text).length === 1 && one.shown === 'announcements {"limit":1}', one.shown);
const pending = await callOperation(hall, op("list_dues"), { status: "pending" });
check("A call returns the tool's JSON", pending.ok && pending.text.includes("Bilal Qureshi"), `${pending.shown}, ${pending.latencyMs} ms`);
const asMember = await asEval(() => callOperation(hall, op("list_dues"), { status: "pending" }), "member:M-102");
check("The user is passed on: a member sees only their own dues", asMember.ok && asMember.text.includes("Bilal") && !asMember.text.includes("Hamza"));
const asAdmin = await asEval(() => callOperation(hall, op("list_dues"), { status: "pending" }), "admin");
check("The admin sees everyone's", asAdmin.ok && asAdmin.text.includes("Bilal") && asAdmin.text.includes("Hamza"));
const other = await asEval(() => callOperation(hall, op("member_details"), { id: "M-104" }), "member:M-102");
check("Another member's details: the tool's own reason is passed on", !other.ok && other.error === "not allowed for this user: members can only see their own details", other.error);
const noUser = await asEval(() => callOperation({ ...hall, user: "none" }, op("list_dues"), { status: "pending" }), "member:M-102");
check('user: "none" - the user is not passed on', noUser.ok && noUser.text.includes("Hamza"));
const badToken = await callOperation({ ...hall, tokenEnc: undefined }, op("duty_on_date"), {});
check("A refused token: reported, not thrown", !badToken.ok && /refused this service.s access/.test(badToken.error), badToken.error);
const badArg = await callOperation(hall, op("announcements"), { limit: "lots" });
check("An argument of the wrong type: the server's error, reported", !badArg.ok && /limit|invalid|expected/i.test(badArg.error), badArg.error.slice(0, 100));
const plan = checkPlan({ calls: [{ operation: "hall.add_announcement", args: [] }, { operation: "hall.list_dues", args: [{ name: "status", value: "pending" }, { name: "drop", value: "x" }] }] }, [hall]);
check("Planner output checked: a tool not stored is dropped, unknown arguments removed", plan.calls.length === 1 && JSON.stringify(plan.calls[0].args) === '{"status":"pending"}');

const withSessions = { ...hall, name: "hall-sessions", baseUrl: "http://localhost:4044/mcp" };
const s1 = await callOperation(withSessions, op("duty_on_date"), {});
const s2 = await callOperation(withSessions, op("list_members"), {});
check("A server with sessions (event-stream answers): calls work", s1.ok && s2.ok && s2.text.includes("Omar Farooq"));
children.get("mcp-sessions").kill();
await new Promise((r) => setTimeout(r, 300));
await sessionsServer(); // the server forgot every session: the kept one answers 404
const s3 = await callOperation(withSessions, op("list_members"), {});
check("A session the server forgot: started again, the call still works", s3.ok && s3.text.includes("Omar Farooq"), s3.error ?? "");

const slow = { ...hall, name: "hall-slow", baseUrl: "http://localhost:4046/mcp", timeoutMs: 1000 };
const timedOut = await callOperation(slow, op("duty_on_date"), {});
check("A slow app: stopped at its time limit, with a clear message", !timedOut.ok && /no answer in 1 s/.test(timedOut.error), timedOut.error);
const down = await callOperation({ ...hall, baseUrl: "http://localhost:4049/mcp" }, op("duty_on_date"), {});
check("A server that is down: reported, not thrown", !down.ok && /could not reach the app/.test(down.error), down.error);

if (process.env.ANSWERS === "1") {
  const { runAgent: runSingle } = await import("../api/agent.js");
  const { runAgent: runSupervisor } = await import("../api/supervisor.js");
  const runAgent = (q, h, o, user) => asEval(() => runSingle(q, h, o), user);
  const runMultiAgent = (q, h, o, user) => asEval(() => runSupervisor(q, h, o), user);
  const get = async (path) => (await fetch(`http://localhost:4041/api${path}`, { headers: { Authorization: "Bearer demo-token" } })).json();
  const today = await get("/ai/duty");
  const cases = [
    { q: "Who is on duty at the hall today?", app: true, expect: today.onDuty.map((d) => d.name.split(" ")[0]) },
    { q: "Which hall members have pending dues?", app: true, expect: ["Bilal", "Hamza", "Omar"] },
    { q: "What was the latest hall announcement?", app: true, expect: ["repair"] },
    { q: "How many members does the hall have?", app: true, expect: ["6"] },
    { q: "What is our rollback process?", app: false, expect: ["tag"] },
    { q: "What is the capital of France?", app: false, expect: ["Paris"] },
  ].filter((c) => !process.env.ONLY || c.q.toLowerCase().includes(process.env.ONLY.toLowerCase()));

  console.log("\n3a. Planner alone (which tools each question calls)");
  for (const c of cases) {
    const d = await appContext(c.q);
    const called = d.calls.map((x) => `${x.operation}${Object.keys(x.args).length ? JSON.stringify(x.args) : ""}`);
    check(`${c.q} -> ${c.app ? "calls the app" : "no app call"}`, c.app ? d.calls.length > 0 && d.calls.every((x) => x.ok) : d.calls.length === 0, called.join(", ") || "none");
  }

  for (const mode of (process.env.MODES ?? "single,multi").split(",")) {
    console.log(`\n3b. Answers - ${mode === "multi" ? "supervisor" : "single agent"}`);
    for (const c of cases) {
      const r = await (mode === "multi" ? runMultiAgent : runAgent)(c.q, []);
      const text = r.answer.toLowerCase();
      const has = c.expect.every((e) => text.includes(e.toLowerCase()));
      const cited = (r.sources ?? []).some((s) => s.source === "hall API");
      check(`${c.q}`, has && (c.app ? cited : !cited), `${c.app ? (cited ? "cites hall API" : "NO hall API source") : cited ? "WRONGLY cites hall API" : "no app source"}${has ? "" : `; missing ${c.expect.filter((e) => !text.includes(e.toLowerCase())).join(", ")}`} | ${r.answer.slice(0, 120).replace(/\n/g, " ")}`);
    }
  }

  console.log("\n3c. Users (single agent)");
  const member = await runAgent("Which hall members have pending dues?", [], {}, "member:M-104");
  check("Member M-104 hears only their own dues", member.answer.includes("Hamza") && !member.answer.includes("Bilal"), member.answer.slice(0, 110).replace(/\n/g, " "));
  const mine = await runAgent("Do I have any pending dues at the hall?", [], {}, "member:M-104");
  check('"Do I have pending dues?" - the whoami tool added, answered for the member', /\byes\b|you have|you owe/i.test(mine.answer) && /500|October/.test(mine.answer), mine.answer.slice(0, 110).replace(/\n/g, " "));
}

await removeApp("hall");
await redis.del(process.env.APPS_KEY);
console.log(`\n${passed}/${total} passed.`);
stop();
process.exit(passed === total ? 0 : 1);
