// Phase 10 #4: connected apps (api/apps.js, appRegistry.js), against the demo
// app (examples/demo-app), started here on ports 4011 and 4012 (slow).
//   1. registration: OpenAPI read, GET only, token encrypted, bad entries refused - no model
//   2. safety: calls stay on the app's URL, time limit, refused token, bad plans dropped - no model
//   2b. who may ask: callers, apps that need a user, the user passed on - no model
//   3. answers (ANSWERS=1): planner + agent on questions about the app's data,
//      and questions that must not call the app (MODES=single,multi; ONLY=<text>)
// Uses its own registry key (apps:registry:eval) and a throwaway encryption
// key, so the real registry is untouched.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

process.env.APPS_KEY = "apps:registry:eval";
process.env.APP_SECRETS_KEY = randomBytes(32).toString("base64");
const { saveApp, removeApp, listApps, getApp, checkUrl } = await import("../api/appRegistry.js");
const { callOperation, checkPlan, buildUrl, appContext: appContextRaw, availableApps } = await import("../api/apps.js");
const { withAccess } = await import("../api/appAccess.js");
// The eval asks as the /api/ask app "eval", as a real app would.
const asEval = (fn, userToken) => withAccess({ caller: "eval", userToken }, fn);
const appContext = (q) => asEval(() => appContextRaw(q));
const { redis } = await import("../api/sessionStore.js");

const DEMO = new URL("../examples/demo-app/server.js", import.meta.url).pathname;
const children = [];
function startDemo(port, env = {}) {
  const child = spawn(process.execPath, [DEMO], { env: { ...process.env, DEMO_APP_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
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

await startDemo(4011);
await startDemo(4012, { DEMO_APP_DELAY_MS: "3000" });
await redis.del(process.env.APPS_KEY);
const HALL = {
  name: "hall",
  description: "Community hall (demo data): volunteer duty roster by day, members, monthly dues paid or pending, announcements",
  openapi: "http://localhost:4011/api/ai/openapi.json",
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
check("OpenAPI read: 7 GET operations, the POST ignored", app.operations.length === 7 && skipped.notGet === 1, `${app.operations.map((o) => o.id).join(", ")}`);
check("Relative server URL resolved against the file", app.baseUrl === "http://localhost:4011/api", app.baseUrl);
check("A $ref parameter is read", app.operations.find((o) => o.id === "announcements")?.params[0]?.name === "limit");
const raw = await redis.hGet(process.env.APPS_KEY, "hall");
check("Token stored encrypted, not shown", !raw.includes("demo-token") && app.hasToken && !("tokenEnc" in app));
check("Wrong token: refused at registration", (await refused(() => saveApp({ ...HALL, name: "hall-bad", token: "wrong" }), /401 - check the token/)) === true);
check("http to another machine: refused", (await refused(() => saveApp({ ...HALL, name: "hall-http", openapi: "http://example.com/openapi.json" }), /must use https/)) === true);
check("Bad name: refused", (await refused(() => saveApp({ ...HALL, name: "Hall App" }), /name:/)) === true);
check("Unknown data level: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", dataLevel: "secret" }), /dataLevel/)) === true);
check("No callers: refused (an app is not open to every caller by default)", (await refused(() => saveApp({ ...HALL, name: "hall-x", callers: undefined }), /callers/)) === true);
check("whoami naming no operation: refused", (await refused(() => saveApp({ ...HALL, name: "hall-x", whoami: "nope" }), /whoami/)) === true);
const limited = await saveApp({ ...HALL, name: "hall-limited", whoami: undefined, allow: ["GET /ai/duty", "GET /ai/dues"] });
check('"allow" keeps only the listed operations', limited.app.operations.length === 2 && limited.skipped.notAllowed === 5);
const kept = await saveApp({ ...HALL, name: "hall-limited", token: undefined, description: "Changed description for the same app" });
check("Saving again without the token keeps it", kept.app.hasToken);
await removeApp("hall-limited");
check("Removed apps are gone", !(await listApps()).some((a) => a.name === "hall-limited"));

console.log("\n2. Safety");
const hall = await getApp("hall");
const op = (id) => hall.operations.find((o) => o.id === id);
const url = buildUrl(hall, op("member_details"), { id: "../../admin?x=1" });
check("A path parameter cannot leave the operation's path", url.pathname === "/api/ai/members/..%2F..%2Fadmin%3Fx%3D1", url.pathname);
check("Plain http is allowed only to this machine", (await refused(async () => checkUrl("http://10.0.0.5/api"), /https/)) === true);
const ok = await callOperation(hall, op("list_dues"), { status: "pending" });
check("A call returns the app's JSON", ok.ok && ok.text.includes("Bilal Qureshi"), `${ok.shown}, ${ok.latencyMs} ms`);
const slow = await saveApp({ ...HALL, name: "hall-slow", openapi: "http://localhost:4012/api/ai/openapi.json", timeoutMs: 5000 });
const slowApp = { ...(await getApp("hall-slow")), timeoutMs: 1000 };
const timedOut = await callOperation(slowApp, slowApp.operations[0], {});
check("A slow app: stopped at its time limit, with a clear message", !timedOut.ok && /no answer in 1 s/.test(timedOut.error), timedOut.error);
await removeApp("hall-slow");
const badToken = await callOperation({ ...hall, tokenEnc: undefined }, op("duty_on_date"), {});
check("A refused token: reported, not thrown", !badToken.ok && /refused this service.s access/.test(badToken.error), badToken.error);
const plan = checkPlan(
  { calls: [{ operation: "hall.nope", args: [] }, { operation: "hall.member_details", args: [] }, { operation: "hall.list_dues", args: [{ name: "status", value: "pending" }, { name: "drop_table", value: "x" }] }] },
  [hall]
);
check("Planner output checked: unknown and incomplete calls dropped, unknown parameters removed", plan.calls.length === 1 && JSON.stringify(plan.calls[0].args) === '{"status":"pending"}' && plan.dropped.length === 2, plan.dropped.join("; "));

console.log("\n2b. Who may ask");
const names = async (access) => (await withAccess(access, () => availableApps())).map((a) => a.name).join(",") || "none";
check("Outside a request (no caller): no apps", (await names({})) === "none");
check('The web chat ("web") does not see an app for "eval" only', (await names({ caller: "web" })) === "none");
check("Another /api/ask app does not see it", (await names({ caller: "crm" })) === "none");
check('The app it names ("eval") sees it', (await names({ caller: "eval" })) === "hall");
const webNone = await withAccess({ caller: "web" }, () => appContextRaw("Who is on duty today?"));
check("Web chat question: no planner call at all", webNone.usage === null && webNone.calls.length === 0);
await saveApp({ ...HALL, name: "hall-users", user: "required" });
check('user: "required" - not available without a user', !(await names({ caller: "eval" })).includes("hall-users"));
check('user: "required" - available with one', (await names({ caller: "eval", userToken: "member:M-102" })).includes("hall-users"));
await removeApp("hall-users");
const asMember = await asEval(() => callOperation(hall, op("list_dues"), { status: "pending" }), "member:M-102");
check("The user is passed on: a member sees only their own dues", asMember.ok && asMember.text.includes("Bilal") && !asMember.text.includes("Hamza"), asMember.text.slice(0, 100));
const asAdmin = await asEval(() => callOperation(hall, op("list_dues"), { status: "pending" }), "admin");
check("The admin sees everyone's", asAdmin.ok && asAdmin.text.includes("Bilal") && asAdmin.text.includes("Hamza"));
const other = await asEval(() => callOperation(hall, op("member_details"), { id: "M-104" }), "member:M-102");
check("Another member's details: the app's own reason is passed on", !other.ok && /not allowed for this user: members can only see their own details/.test(other.error), other.error);
const noUserHeader = await asEval(() => callOperation({ ...hall, user: "none" }, op("list_dues"), { status: "pending" }), "member:M-102");
check('user: "none" - the user is not passed on', noUserHeader.ok && noUserHeader.text.includes("Hamza"));

if (process.env.ANSWERS === "1") {
  const { runAgent: runSingle } = await import("../api/agent.js");
  const { runAgent: runSupervisor } = await import("../api/supervisor.js");
  const runAgent = (q, h, o, user) => asEval(() => runSingle(q, h, o), user);
  const runMultiAgent = (q, h, o, user) => asEval(() => runSupervisor(q, h, o), user);
  const get = async (path) => (await fetch(`http://localhost:4011/api${path}`, { headers: { Authorization: "Bearer demo-token" } })).json();
  const today = await get("/ai/duty");
  const latest = (await get("/ai/announcements"))[0];
  const cases = [
    { q: "Who is on duty at the hall today?", app: true, expect: today.onDuty.map((d) => d.name.split(" ")[0]) },
    { q: "Which hall members have pending dues?", app: true, expect: ["Bilal", "Hamza", "Omar"] },
    { q: "What was the latest hall announcement?", app: true, expect: [latest.title.includes("repairs") ? "repair" : latest.title] },
    { q: "How many members does the hall have?", app: true, expect: ["6"] },
    // Names no app: the router sent it to general (found with the masjid
    // app); applyAppPriority sends it to connected_apps.
    { q: "Is there any new announcement?", app: true, expect: ["repair"] },
    { q: "What is our rollback process?", app: false, expect: ["tag"] },
    { q: "What is the capital of France?", app: false, expect: ["Paris"] },
  ].filter((c) => !process.env.ONLY || c.q.toLowerCase().includes(process.env.ONLY.toLowerCase()));

  console.log("\n3a. Planner alone (which calls each question makes)");
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
      const okCase = has && (c.app ? cited : !cited);
      check(`${c.q}`, okCase, `${c.app ? (cited ? "cites hall API" : "NO hall API source") : cited ? "WRONGLY cites hall API" : "no app source"}${has ? "" : `; missing ${c.expect.filter((e) => !text.includes(e.toLowerCase())).join(", ")}`} | ${r.answer.slice(0, 120).replace(/\n/g, " ")}`);
    }
  }

  console.log("\n3c. The same question, two users (single agent and supervisor)");
  for (const [label, run] of [["single", runAgent], ["multi", runMultiAgent]]) {
    const member = await run("Which hall members have pending dues?", [], {}, "member:M-104");
    const admin = await run("Which hall members have pending dues?", [], {}, "admin");
    check(`${label}: member M-104 hears only their own dues`, member.answer.includes("Hamza") && !member.answer.includes("Bilal"), member.answer.slice(0, 110).replace(/\n/g, " "));
    check(`${label}: the admin hears everyone's`, admin.answer.includes("Hamza") && admin.answer.includes("Bilal"), admin.answer.slice(0, 110).replace(/\n/g, " "));
    // "I" is the asking user: the app's whoami call is added in code.
    const mine = await run("Do I have any pending dues at the hall?", [], {}, "member:M-104");
    // Their due is October's 500 INR: either is the right answer, a plain "no" is not.
    check(`${label}: "Do I have pending dues?" - answered for the member, yes`, /\byes\b|you have|you owe/i.test(mine.answer) && /500|October/.test(mine.answer), mine.answer.slice(0, 110).replace(/\n/g, " "));
  }
}

await removeApp("hall");
const none = await appContext("Who is on duty today?");
check("No apps registered: no planner call", none.usage === null && none.calls.length === 0);
await redis.del(process.env.APPS_KEY);
console.log(`\n${passed}/${total} passed.`);
stop();
process.exit(passed === total ? 0 : 1);
