// Step 1 of app knowledge: each connected app's own help pages (api/knowledge.js),
// against the demo app (examples/demo-app, its /api/ai/help.md, port 4014) and a
// second, help-only app served here (port 4015) - to show one app's pages never
// reach another app's caller.
//   1. reading the file: pages, sections, chunks - no model, no database
//   2. registration: indexed on add and refresh, bad files refused, removed with the app - database + embeddings
//   3. scope: a search sees only the apps it is given - database + embeddings
//   roles: "Roles: owner" under a heading - other roles get who can do it, not the steps
//   4. answers (ANSWERS=1): how-to questions answered from the right app's pages,
//      as an /api/ask app pinned to connected_apps (like the masjid assistant)
// Uses its own registry key, table and encryption key; embeds with the
// in-process model (EMBED_PROVIDER=local, as on Vercel), so Ollama is not needed
// except as the answering model if LLM_PROVIDER says so.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

process.env.APPS_KEY = "apps:registry:eval-knowledge";
process.env.APP_KNOWLEDGE_TABLE = "app_knowledge_eval";
process.env.APP_SECRETS_KEY = randomBytes(32).toString("base64");
process.env.EMBED_PROVIDER ??= "local";
const { saveApp, refreshApp, removeApp } = await import("../api/appRegistry.js");
const { appContext } = await import("../api/apps.js");
const { parsePages, chunkPages, searchKnowledge, parseRoles } = await import("../api/knowledge.js");
const { withAccess } = await import("../api/appAccess.js");
const { db } = await import("../api/tools.js");
const { redis } = await import("../api/sessionStore.js");

const DEMO = new URL("../examples/demo-app/server.js", import.meta.url).pathname;
const demo = spawn(process.execPath, [DEMO], { env: { ...process.env, DEMO_APP_PORT: "4014" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => demo.stdout.once("data", resolve));

// A help-only app: a garage app's pages, changed during the test.
let garageHelp = `# Quotes
## Send a quote
Open the job, tap Draft quote, tick the work, then tap Send quote on WhatsApp. The customer approves it on the link.

# Team
## Add a mechanic
Open Garage & team, then Team, and tap Add a person. Then tap Make login link and send it on WhatsApp.

# Pay & leave
Roles: owner

## Pay a salary
Open Garage & team, then Pay & leave, tap Pay salary next to the person, add a bonus or deduction, then Save and send payslip.
`;
const files = {
  "/help.md": () => [200, "text/markdown", garageHelp],
  "/page": () => [200, "text/html", "<!doctype html><html><body>app</body></html>"],
  "/json": () => [200, "application/json", '{"pages":[]}'],
  "/empty": () => [200, "text/markdown", "\n\n   \n"],
  "/gone": () => [404, "text/plain", "not found"],
};
const garageServer = createServer((req, res) => {
  const [status, type, body] = (files[req.url] ?? files["/gone"])();
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}).listen(4015);
const stop = () => {
  demo.kill();
  garageServer.close();
};
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
const rowsOf = async (app) => (await db.query(`SELECT source, content FROM app_knowledge_eval WHERE app = $1 ORDER BY chunk_index`, [app])).rows;

console.log("1. Reading the file");
const pages = parsePages("Intro line\n\n# One\ntext a\n## Part\ntext b\n### Deeper\ntext c\n## Empty\n\n# Two ##\ntext d\n");
check("Pages from # headings, text before them is Overview", pages.map((p) => p.title).join("|") === "Overview|One|Two", pages.map((p) => p.title).join("|"));
check("Sections from ## and ###, empty ones dropped", pages[1].sections.map((s) => s.heading).join("|") === "|Part|Deeper", pages[1].sections.map((s) => s.heading).join("|"));
const long = chunkPages("x", parsePages(`# Long\n${Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"word ".repeat(15)}`).join("\n\n")}`));
check("A long section is cut between paragraphs, each piece at most 1,200 characters", long.length > 1 && long.every((c) => c.content.length <= 1200 + 30) && long.every((c) => /^x help: Long\nParagraph \d+/.test(c.content)), `${long.length} chunks`);
const labelled = chunkPages("hall", parsePages("# Paying dues\n## Receipts\nUnder Profile."));
check('Chunks say where they came from ("hall help: Paying dues > Receipts"), source is the page', labelled[0].content.startsWith("hall help: Paying dues > Receipts\n") && labelled[0].source === "hall help: Paying dues");

const tagged = parsePages("# Money\nRoles: Owner, manager, bad role!\n\n## Salaries\ntext\n## Prices\n\nRoles: advisor\ntext\n# Open\ntext\nRoles: owner\n");
check("Roles: under a page applies to its sections, lower-cased, bad names dropped", tagged[0].sections[0].roles.join(",") === "owner,manager", JSON.stringify(tagged[0].sections[0].roles));
check("A section's own Roles: line wins over its page's", tagged[0].sections[1].roles.join(",") === "advisor" && tagged[0].sections[1].text === "text");
check('"Roles:" not right under a heading is plain text, the page is for everyone', tagged[1].roles.length === 0 && tagged[1].sections[0].text.includes("Roles: owner"));
check("parseRoles", parseRoles(" Owner ,mechanic,, x y ").join(",") === "owner,mechanic");

console.log("\n2. Registration");
await redis.del(process.env.APPS_KEY);
await db.query("DROP TABLE IF EXISTS app_knowledge_eval");
const HALL = {
  name: "hall",
  description: "Community hall (demo data): volunteer duty roster by day, members, monthly dues paid or pending, announcements",
  openapi: "http://localhost:4014/api/ai/openapi.json",
  knowledge: "http://localhost:4014/api/ai/help.md",
  token: "demo-token",
  dataLevel: "internal",
  timezone: "Asia/Kolkata",
  timeoutMs: 10000,
  callers: ["eval"],
};
const GARAGE = { name: "garage", description: "Garage app (demo): how to use quotes and the team screens", knowledge: "http://localhost:4015/help.md", dataLevel: "public", callers: ["garage-app"] };
const hall = (await saveApp(HALL)).app;
check("API app with help pages: operations read and pages indexed", hall.operations.length === 7 && hall.knowledgeInfo?.pages === 3 && hall.knowledgeInfo?.chunks === 5, JSON.stringify(hall.knowledgeInfo));
check("Help pages fetched with the app's token", (await rowsOf("hall")).length === 5);
const garage = (await saveApp(GARAGE)).app;
check('Help-only app: no operations, kind "knowledge"', garage.kind === "knowledge" && garage.operations.length === 0 && garage.knowledgeInfo?.chunks === 3, JSON.stringify(garage.knowledgeInfo));
check("Roles stored with the chunks", (await db.query("SELECT roles FROM app_knowledge_eval WHERE source = 'garage help: Pay & leave'")).rows[0]?.roles?.join(",") === "owner");
check("No openapi, mcp or knowledge: refused", (await refused(() => saveApp({ ...GARAGE, name: "none", knowledge: undefined }), /openapi.*mcp.*knowledge/)) === true);
check("An HTML page instead of Markdown: refused", (await refused(() => saveApp({ ...GARAGE, name: "html", knowledge: "http://localhost:4015/page" }), /HTML page/)) === true);
check("JSON instead of Markdown: refused", (await refused(() => saveApp({ ...GARAGE, name: "json", knowledge: "http://localhost:4015/json" }), /Markdown/)) === true);
check("An empty file: refused", (await refused(() => saveApp({ ...GARAGE, name: "empty", knowledge: "http://localhost:4015/empty" }), /no text/)) === true);
check("http to another machine: refused", (await refused(() => saveApp({ ...GARAGE, name: "far", knowledge: "http://example.com/help.md" }), /must use https/)) === true);
check("Refused files left nothing behind", (await db.query("SELECT DISTINCT app FROM app_knowledge_eval ORDER BY app")).rows.map((r) => r.app).join(",") === "garage,hall");

garageHelp += "\n# Reminders\n## Stop reminders\nCustomers who reply STOP get no more reminders from your garage.\n";
const refreshed = (await refreshApp("garage")).app;
check("Refresh reads the changed file: 4 pages", refreshed.knowledgeInfo?.pages === 4 && (await rowsOf("garage")).some((r) => r.content.includes("reply STOP")), JSON.stringify(refreshed.knowledgeInfo));
files["/help.md"] = files["/gone"];
check("A refresh that fails keeps the pages indexed before", (await refused(() => refreshApp("garage"), /answered 404/)) === true && (await rowsOf("garage")).length === 4);
files["/help.md"] = () => [200, "text/markdown", garageHelp];
await saveApp({ ...HALL, name: "hall-copy" });
await saveApp({ ...HALL, name: "hall-copy", knowledge: undefined });
check("Saving an app without its knowledge URL removes its pages", (await rowsOf("hall-copy")).length === 0);
await saveApp({ ...HALL, name: "hall-copy" });
await removeApp("hall-copy");
check("Removing an app removes its pages", (await rowsOf("hall-copy")).length === 0);

console.log("\n3. Scope");
const hallOnly = await searchKnowledge("How do I send a quote on WhatsApp?", ["hall"]);
check("A search among hall's pages finds none of garage's", hallOnly.length > 0 && hallOnly.every((r) => r.app === "hall"));
const garageOnly = await searchKnowledge("How do I send a quote on WhatsApp?", ["garage"]);
check("Among garage's pages: the quote page first", garageOnly[0]?.source === "garage help: Quotes", garageOnly[0]?.source);
check("No apps given: no search", (await searchKnowledge("anything", [])).length === 0);

if (process.env.ANSWERS === "1") {
  const { runAgent } = await import("../api/supervisor.js");
  const ask = (caller, q, role) => withAccess({ caller, role }, () => runAgent(q, [], { forceAgent: "connected_apps" }));
  const context = (caller, q) => withAccess({ caller }, () => appContext(q));
  console.log("\n4. Answers");
  const cases = [
    { caller: "eval", q: "How do I swap my duty day with someone?", source: "hall help: Duty swaps", says: [/swap/i, /accept/i] },
    { caller: "eval", q: "كيف أدفع الاشتراك الشهري؟", source: "hall help: Paying dues", says: [/./] },
    { caller: "garage-app", q: "How do I add a new mechanic to my team?", source: "garage help: Team", says: [/add a person/i, /login link/i] },
    { caller: "garage-app", q: "Can customers stop the reminders?", source: "garage help: Reminders", says: [/stop/i] },
    { caller: "eval", q: "How do I send a quote on WhatsApp?", source: null, says: [] },
  ];
  for (const c of cases.filter((x) => !process.env.ONLY || x.q.includes(process.env.ONLY))) {
    const r = await ask(c.caller, c.q);
    const sources = (r.sources ?? []).map((s) => s.source ?? s);
    if (c.source) {
      const ok = sources.some((s) => String(s).includes(c.source)) && c.says.every((re) => re.test(r.answer));
      check(`${c.caller}: "${c.q}" -> ${c.source}`, ok, ok ? "" : `sources ${JSON.stringify(sources)}; ${r.answer.slice(0, 200)}`);
    } else {
      const ok = !sources.some((s) => /garage help/.test(String(s)));
      check(`${c.caller}: "${c.q}" -> not from another app's pages`, ok, `${r.answer.slice(0, 160)}`);
    }
  }
  if (!process.env.ONLY || /salar/.test(process.env.ONLY)) {
    const q = "How do I pay a salary to my mechanic?";
    const owner = await ask("garage-app", q, "owner");
    check("Owner asks an owner-only how-to: gets the steps", /pay salary/i.test(owner.answer) && /payslip/i.test(owner.answer), owner.answer.slice(0, 200));
    const mech = await ask("garage-app", q, "mechanic");
    check("Mechanic asks it: told only the owner can, no steps", /owner/i.test(mech.answer) && !/payslip/i.test(mech.answer), mech.answer.slice(0, 200));
    const none = await withAccess({ caller: "garage-app" }, () => appContext(q));
    check("No role sent: the owner-only page has no steps in it", none.chunks.some((c) => c.source === "garage help: Pay & leave") && none.chunks.every((c) => !/Save and send payslip/.test(c.content)));
  }
  const data = await context("eval", "Who is on duty today?");
  check("A data question still calls the API", data.calls.some((c) => c.operation === "duty_today" || c.operation === "duty_on_date" || /duty/.test(c.operation)), data.calls.map((c) => c.operation).join(", "));
}

await redis.del(process.env.APPS_KEY);
await db.query("DROP TABLE IF EXISTS app_knowledge_eval");
console.log(`\n${passed}/${total} passed`);
stop();
await db.end();
await redis.quit?.();
process.exit(passed === total ? 0 : 1);
