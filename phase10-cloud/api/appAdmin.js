// Phase 10 #4: the command line for the connected-apps admin API (adminApi.js).
//
//   npm run app -- list
//   npm run app -- add <app.json>        add or replace an app (see ../apps/*.example.json)
//   npm run app -- refresh <name>        read its OpenAPI file (or MCP tools) and help pages again after the app changed
//   npm run app -- remove <name>
//   npm run app -- try "<question>" [user-token]   which app calls a question makes, and what came back
//                                        (user-token: as a logged-in user of an app with "user")
//   npm run app -- keys                  new values for ADMIN_KEY and APP_SECRETS_KEY (nothing saved)
//
//   /api/ask keys, stored hashed in Redis (askKeys.js) - work at once, no deployment:
//   npm run app -- askkey list
//   npm run app -- askkey new <app>      a new key, shown once - give it to the app
//   npm run app -- askkey import <app> <ENV_VAR>   store a key the app already has (from ../.env),
//                                        e.g. one moved out of APP_API_KEYS, so the app changes nothing
//   npm run app -- askkey revoke <id|app>   one key by its id, or all of an app's keys
//
// Talks to API_URL (default the Mac, http://localhost:3002) with ADMIN_KEY
// from ../.env. For the live app: API_URL=https://ai-engineer-api-jet.vercel.app
// and the ADMIN_KEY set on Vercel.
//
// In the app's file, "token": "$MASJID_AI_TOKEN" is read from the environment
// (../.env), so the token itself is never in a file that could be committed.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const [cmd, arg] = process.argv.slice(2);
const API_URL = (process.env.API_URL ?? "http://localhost:3002").replace(/\/$/, "");

if (cmd === "keys") {
  console.log("Add both to ../.env and to Vercel (ai-engineer-api, Sensitive), then deploy once:\n");
  console.log(`  ADMIN_KEY=adm_${randomBytes(24).toString("base64url")}`);
  console.log(`  APP_SECRETS_KEY=${randomBytes(32).toString("base64")}\n`);
  console.log("Keep APP_SECRETS_KEY: tokens stored with it cannot be read with another one.");
  process.exit(0);
}

const usage = 'Usage: npm run app -- list | add <app.json> | refresh <name> | remove <name> | try "<question>" | keys | askkey list|new|import|revoke';
const askkeyArgs = { list: 0, new: 1, import: 2, revoke: 1 };
const askkeyOk = cmd === "askkey" && arg in askkeyArgs && process.argv.slice(4).filter(Boolean).length >= askkeyArgs[arg];
if (!(["list", "add", "refresh", "remove", "try"].includes(cmd) || askkeyOk) || (cmd !== "list" && !arg)) {
  console.error(usage);
  process.exit(1);
}
if (!process.env.ADMIN_KEY) {
  console.error("ADMIN_KEY is not set (../.env). `npm run app -- keys` makes one.");
  process.exit(1);
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${API_URL}/api/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.ADMIN_KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    console.error(`Could not reach ${API_URL}: ${err.cause?.code ?? err.message}`);
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${res.status}: ${data.error ?? "request failed"}`);
    process.exit(1);
  }
  return data;
}

function showApp(a) {
  console.log(`${a.name} - ${a.description}`);
  console.log(`  ${a.kind === "mcp" ? "MCP " : ""}${a.baseUrl ?? "help pages only"}  (${a.dataLevel}${a.timezone ? `, ${a.timezone}` : ""}, token ${a.hasToken ? "stored" : "none"}, updated ${a.updatedAt})`);
  if (a.knowledge) console.log(`  help pages: ${a.knowledge} - ${a.knowledgeInfo?.pages ?? 0} pages, ${a.knowledgeInfo?.chunks ?? 0} chunks, indexed ${a.knowledgeInfo?.indexedAt ?? "-"}`);
  console.log(`  asked by: ${(a.callers ?? []).join(", ") || "nobody"}; user: ${a.user ?? "none"}`);
  for (const op of a.operations) console.log(`  ${op.tool ? `tool ${op.tool}` : `GET ${op.path}`}  - ${op.summary}${op.params.length ? `  [${op.params.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ")}]` : ""}`);
}

if (cmd === "list") {
  const { apps } = await call("GET", "/apps");
  if (!apps.length) console.log(`No connected apps at ${API_URL}.`);
  apps.forEach(showApp);
} else if (cmd === "add") {
  const entry = JSON.parse(readFileSync(arg, "utf-8"));
  if (typeof entry.token === "string" && entry.token.startsWith("$")) {
    const value = process.env[entry.token.slice(1)];
    if (!value) {
      console.error(`${entry.token} is not set (../.env).`);
      process.exit(1);
    }
    entry.token = value;
  }
  const { app, skipped } = await call("PUT", `/apps/${encodeURIComponent(entry.name)}`, entry);
  console.log(`Saved at ${API_URL}:`);
  showApp(app);
  const notes = [skipped.notGet && `${skipped.notGet} non-GET ignored`, skipped.notReadOnly && `${skipped.notReadOnly} tool${skipped.notReadOnly > 1 ? "s" : ""} not marked read-only ignored`, skipped.notAllowed && `${skipped.notAllowed} not in "allow"`, skipped.overLimit && `${skipped.overLimit} over the limit of 15`].filter(Boolean);
  if (notes.length) console.log(`  (${notes.join(", ")})`);
} else if (cmd === "refresh") {
  const { app } = await call("POST", `/apps/${encodeURIComponent(arg)}/refresh`);
  showApp(app);
} else if (cmd === "remove") {
  await call("DELETE", `/apps/${encodeURIComponent(arg)}`);
  console.log(`Removed ${arg}.`);
} else if (cmd === "try") {
  const userToken = process.argv[4];
  const { calls, dropped, help = [], excerpts } = await call("POST", "/try", { question: arg, ...(userToken ? { userToken } : {}) });
  if (!calls.length) console.log("No app calls for this question.");
  if (!help.length) console.log("No help pages for this question.");
  for (const [i, c] of calls.entries()) {
    console.log(`${c.ok ? "OK " : "ERR"} ${c.app}.${c.operation} ${JSON.stringify(c.args)} ${c.latencyMs ?? "-"} ms${c.error ? ` - ${c.error}` : ""}`);
    console.log(`    ${excerpts[i].replace(/\n/g, "\n    ").slice(0, 800)}`);
  }
  for (const [i, h] of help.entries()) {
    console.log(`HELP ${h.source}`);
    console.log(`    ${excerpts[calls.length + i].replace(/\n/g, "\n    ").slice(0, 800)}`);
  }
  if (dropped.length) console.log(`Dropped: ${dropped.join("; ")}`);
}
else if (cmd === "askkey") {
  const [target, envVar] = process.argv.slice(4);
  if (arg === "list") {
    const { keys, fromEnv } = await call("GET", "/ask-keys");
    if (!keys.length) console.log(`No stored /api/ask keys at ${API_URL}.`);
    for (const k of keys) console.log(`${k.name.padEnd(16)} id ${k.id}  ...${k.hint}  made ${k.createdAt}`);
    if (fromEnv.length) console.log(`Also in APP_API_KEYS (env, changed only on Vercel): ${fromEnv.join(", ")}`);
  } else if (arg === "new" || arg === "import") {
    let key;
    if (arg === "import") {
      key = process.env[envVar.replace(/^\$/, "")];
      if (!key) {
        console.error(`${envVar} is not set (../.env).`);
        process.exit(1);
      }
    }
    const k = await call("POST", "/ask-keys", { name: target, ...(key ? { key } : {}) });
    console.log(`Stored at ${API_URL}: ${k.name}, id ${k.id}, ...${k.hint} - works now, no deployment.`);
    if (arg === "new") console.log(`\nThe key (shown only this once - give it to "${k.name}" as "Authorization: Bearer <key>"):\n\n  ${k.key}\n`);
  } else {
    const { revoked, note } = await call("DELETE", `/ask-keys/${encodeURIComponent(target)}`);
    console.log(`Revoked ${revoked.join(", ")} - refused from the next request.`);
    if (note) console.log(note);
  }
}
