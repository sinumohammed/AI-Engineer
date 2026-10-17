// Phase 10 #4 (10d.9): the second connector type - an app that offers its
// data as an MCP server (Streamable HTTP) instead of an OpenAPI file. The same
// planner, callers, users and citations as OpenAPI apps (apps.js); only how
// the operations are found and called differs:
//
//   registration: initialize -> tools/list -> the read-only tools, stored with
//                 the app as operations (the same shape openapiTools.js makes)
//   a question:   initialize (or the session kept from before) -> tools/call
//
// Hand-written over fetch, not the MCP SDK: a few JSON-RPC requests, and the
// same rules as the OpenAPI calls stay in plain sight - no redirects, a time
// limit, a size limit, the app's token and the user's token as headers.
//
// Read-only: MCP has no GET. A tool is used only when the server marks it
// readOnlyHint: true; tools that change data, or say nothing, are left out
// whatever the app's entry says. The hint is the server's own claim - as with
// an OpenAPI app's GET, the app is trusted to keep its read-only promise.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "ai-engineer", version: "1.0.0" };
const MAX_OPERATIONS = 15; // as for OpenAPI apps: each one costs prompt tokens on every planned question
const MAX_TEXT = 300;
const MAX_BODY_BYTES = 1000000;
const SESSION_MS = 10 * 60 * 1000;

const short = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "");

export class McpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// One JSON-RPC message to the server. The answer is JSON, or an event stream
// (text/event-stream) whose message with our id is the answer.
async function post(url, message, { token, userToken, sessionId, protocolVersion, timeoutMs }) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(userToken ? { "X-User-Token": userToken } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = (await res.text()).slice(0, MAX_BODY_BYTES);
  if (!res.ok) {
    let why = "";
    try {
      const body = JSON.parse(text);
      why = String(body.error?.message ?? body.error ?? "").slice(0, 200);
    } catch {
      // no JSON message
    }
    throw new McpError(`${res.status}${why ? ` - ${why}` : ""}`, res.status);
  }
  if (message.id === undefined) return { sessionId: res.headers.get("mcp-session-id") }; // a notification: 202, no body
  let reply = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      try {
        const msg = JSON.parse(data);
        if (msg.id === message.id) reply = msg;
      } catch {
        // not JSON: a comment or a keep-alive
      }
    }
  } else {
    try {
      reply = JSON.parse(text);
    } catch {
      // handled below
    }
  }
  if (!reply) throw new McpError("the server's answer was not an MCP message");
  if (reply.error) throw new McpError(`${reply.error.message ?? "error"}${reply.error.code ? ` (${reply.error.code})` : ""}`);
  return { result: reply.result, sessionId: res.headers.get("mcp-session-id") };
}

// Sessions kept per app and user, so a question costs one request (tools/call),
// not three. A stateless server gives no session id; the handshake is kept all
// the same, so it is not repeated either. An expired session (404) is started again.
const sessions = new Map();

async function connect(url, opts) {
  let nextId = 1;
  const init = await post(url, { jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, opts);
  const s = { sessionId: init.sessionId, protocolVersion: init.result?.protocolVersion ?? PROTOCOL_VERSION, serverInfo: init.result?.serverInfo, nextId, at: Date.now() };
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { ...opts, ...s });
  return s;
}

async function request(url, method, params, opts, key = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let s = key && sessions.get(key);
    if (!s || Date.now() - s.at > SESSION_MS) {
      s = await connect(url, opts);
      if (key) {
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.set(key, s);
      }
    }
    try {
      return (await post(url, { jsonrpc: "2.0", id: s.nextId++, method, params }, { ...opts, sessionId: s.sessionId, protocolVersion: s.protocolVersion })).result;
    } catch (err) {
      if (key) sessions.delete(key);
      if (!(err.status === 404 && s.sessionId && attempt === 0)) throw err;
    }
  }
}

// At registration: the server's tools, up to 5 pages of them.
export async function listMcpTools(url, { token, timeoutMs }) {
  const opts = { token, timeoutMs };
  const s = await connect(url, opts);
  const tools = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await post(url, { jsonrpc: "2.0", id: s.nextId++, method: "tools/list", params: cursor ? { cursor } : {} }, { ...opts, sessionId: s.sessionId, protocolVersion: s.protocolVersion });
    tools.push(...(r.result?.tools ?? []));
    cursor = r.result?.nextCursor;
    if (!cursor) break;
  }
  return { tools, title: short(s.serverInfo?.title ?? s.serverInfo?.name) };
}

// The tools -> operations for the planner. `allow`: optional tool names from
// the app's entry - only these are kept (and still only read-only ones).
export function readMcpTools(tools, { allow } = {}) {
  const allowed = allow?.length ? new Set(allow.map((a) => a.trim())) : null;
  const operations = [];
  const skipped = { notReadOnly: 0, notAllowed: 0, overLimit: 0 };
  const ids = new Set();
  for (const t of tools) {
    if (typeof t?.name !== "string" || !t.name) continue;
    if (t.annotations?.readOnlyHint !== true) {
      skipped.notReadOnly++;
      continue;
    }
    if (allowed && !allowed.has(t.name)) {
      skipped.notAllowed++;
      continue;
    }
    if (operations.length >= MAX_OPERATIONS) {
      skipped.overLimit++;
      continue;
    }
    // The planner names a call "<app>.<id>": an id has no dots or dashes; the
    // tool's own name is kept for the call.
    let id = t.name.replace(/[^A-Za-z0-9_]/g, "_");
    while (ids.has(id)) id += "_";
    ids.add(id);
    const schema = t.inputSchema ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const params = Object.entries(schema.properties ?? {}).map(([name, p]) => ({
      name,
      in: "arg",
      required: required.has(name),
      type: Array.isArray(p?.type) ? p.type.find((x) => x !== "null") ?? "string" : p?.type ?? "string",
      ...(p?.format ? { format: p.format } : {}),
      ...(Array.isArray(p?.enum) ? { enum: p.enum.map(String).slice(0, 20) } : {}),
      description: short(p?.description),
    }));
    operations.push({ id, tool: t.name, summary: short(t.description ?? t.title) || t.name, description: "", params });
  }
  if (!operations.length) {
    throw new Error(
      `no read-only tools to use (${tools.length} tools; ${skipped.notReadOnly} not marked readOnlyHint${allowed ? `, ${skipped.notAllowed} not in "allow"` : ""})`
    );
  }
  return { operations, skipped };
}

// The planner gives every value as a string; the tool gets the type its
// schema asks for ("limit": 2, not "2"). A value that does not fit is passed
// as given, and the server's own check reports it.
function typed(op, args) {
  const out = {};
  for (const [name, value] of Object.entries(args)) {
    const type = op.params.find((p) => p.name === name)?.type;
    if ((type === "integer" || type === "number") && value.trim() !== "" && Number.isFinite(Number(value))) out[name] = Number(value);
    else if (type === "boolean" && /^(true|false)$/i.test(value)) out[name] = value.toLowerCase() === "true";
    else if (type === "object" || type === "array") {
      try {
        out[name] = JSON.parse(value);
      } catch {
        out[name] = value;
      }
    } else out[name] = value;
  }
  return out;
}

// One tools/call, the same result shape as apps.js callOperation. Never throws.
export async function callMcpTool(app, op, args, { token, userToken, maxChars }) {
  const params = typed(op, args);
  // "(MCP tool)" in the label under the answer: with a bare "pending_dues" the
  // local model left out the data's own note that the list is the member's own.
  const shown = `${op.tool} (MCP tool)${Object.keys(params).length ? ` ${JSON.stringify(params)}` : ""}`;
  const startedAt = Date.now();
  const key = `${app.name}\n${app.baseUrl}\n${userToken ?? ""}`;
  try {
    const r = await request(app.baseUrl, "tools/call", { name: op.tool, arguments: params }, { token, userToken, timeoutMs: app.timeoutMs }, key);
    const latencyMs = Date.now() - startedAt;
    // Text parts are the result; structuredContent when a server gives only that.
    let text = (r?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
    if (!text && r?.structuredContent) text = JSON.stringify(r.structuredContent);
    if (r?.isError) {
      // The tool's own words, so the answer can say why ("members can only see their own details").
      return { ok: false, shown, latencyMs, error: text.slice(0, 300) || "the tool reported an error" };
    }
    try {
      text = JSON.stringify(JSON.parse(text)); // compact: fewer tokens
    } catch {
      // not JSON: passed on as text
    }
    const cut = text.length > maxChars;
    return { ok: true, shown, status: 200, latencyMs, text: cut ? text.slice(0, maxChars) : text, cut };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const error =
      err.name === "TimeoutError" ? `no answer in ${Math.round(app.timeoutMs / 1000)} s - the app may be starting up, try again in a minute`
      : err.status === 401 || err.status === 403 ? `the app refused this service's access (${err.message})`
      : err instanceof McpError ? `the app returned an error (${err.message})`
      : `could not reach the app (${err.cause?.code ?? err.cause?.message ?? err.message})`;
    return { ok: false, shown, status: err.status, latencyMs, error };
  }
}
