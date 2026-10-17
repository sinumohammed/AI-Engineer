// Phase 10 #4 (10d.9): a demo MCP server for testing the MCP connector
// (api/mcpTools.js) - the same community hall data as ../demo-app, offered as
// MCP tools instead of an OpenAPI file. It wraps the demo app's /api/ai/*
// endpoints, the way an existing app's API can be put behind MCP without
// changing it. Built with the official SDK on purpose: the connector's client
// is hand-written, so this checks it against the reference implementation.
//
//   node server.js     (DEMO_MCP_PORT, default 4020; DEMO_APP_URL, default http://localhost:4010/api)
//   DEMO_MCP_SESSIONS=1 node server.js   gives each client a session (Mcp-Session-Id), as many servers do
//
// Needs the demo app running. Same token ("Authorization: Bearer demo-token")
// and users (X-User-Token "admin" or "member:M-101") as the demo app; both are
// passed on to it, so the demo app's own rules decide what a user sees.
//
// Tools marked readOnlyHint are the ones the connector will use; add_announcement
// is not, so the connector must leave it out.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.DEMO_MCP_PORT ?? 4020);
const APP_URL = (process.env.DEMO_APP_URL ?? "http://localhost:4010/api").replace(/\/$/, "");
const TOKEN = process.env.DEMO_APP_TOKEN ?? "demo-token";
const SESSIONS = process.env.DEMO_MCP_SESSIONS === "1";

// One demo-app call -> an MCP tool result. A refusal is a tool error with the
// app's reason, which the connector passes on to the answer.
async function fromApp(path, query, headers) {
  const url = new URL(APP_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const user = headers?.["x-user-token"];
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, ...(user ? { "X-User-Token": user } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = res.status === 403 ? `not allowed for this user: ${body.error}` : `${res.status} - ${body.error ?? "the app returned an error"}`;
    return { content: [{ type: "text", text: why }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

function hallServer() {
  const server = new McpServer({ name: "community-hall", version: "1.0.0" });
  const tool = (name, description, inputSchema, run) =>
    server.registerTool(name, { description, inputSchema, annotations: readOnly }, (args, extra) => run(args, extra.requestInfo?.headers));

  tool("me", "The asking user: their member record, own dues and upcoming duty days (admin: just the role)", {}, (_, h) => fromApp("/ai/me", {}, h));
  tool(
    "duty_on_date",
    "Volunteers on duty on one day, with their roles",
    { date: z.string().optional().describe("Day as YYYY-MM-DD; today if left out") },
    (a, h) => fromApp("/ai/duty", a, h)
  );
  tool(
    "duty_schedule",
    "The duty roster for a range of days (at most 31)",
    { from: z.string().describe("First day, YYYY-MM-DD"), to: z.string().describe("Last day, YYYY-MM-DD") },
    (a, h) => fromApp("/ai/schedule", a, h)
  );
  tool("list_members", "Members: id, name, date joined", { search: z.string().optional().describe("Part of a name") }, (a, h) => fromApp("/ai/members", a, h));
  tool(
    "member_details",
    "One member, with their dues and upcoming duty days",
    { id: z.string().describe("Member id like M-101") },
    (a, h) => fromApp(`/ai/members/${encodeURIComponent(a.id)}`, {}, h)
  );
  tool(
    "list_dues",
    "Monthly dues per member, paid or pending (this month and last)",
    { status: z.enum(["pending", "paid"]).optional() },
    (a, h) => fromApp("/ai/dues", a, h)
  );
  // An integer argument: the connector must send a number, not the string "2".
  tool(
    "announcements",
    "Recent announcements, newest first",
    { limit: z.number().int().min(1).max(20).optional().describe("How many, default 5") },
    (a, h) => fromApp("/ai/announcements", a, h)
  );
  // Changes data: no readOnlyHint, so the connector must never offer it.
  server.registerTool(
    "add_announcement",
    { description: "Post a new announcement", inputSchema: { title: z.string(), text: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async () => ({ content: [{ type: "text", text: "posted (demo - nothing is stored)" }] })
  );
  return server;
}

const sessions = new Map(); // session id -> transport (DEMO_MCP_SESSIONS=1)

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

createServer(async (req, res) => {
  const fail = (status, message) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };
  if (new URL(req.url, "http://x").pathname !== "/mcp") return fail(404, "not found - the MCP endpoint is /mcp");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(401, "access token required");
  try {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    if (!SESSIONS) {
      // Stateless: a fresh server and transport for every request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close());
      await hallServer().connect(transport);
      return await transport.handleRequest(req, res, body);
    }
    const id = req.headers["mcp-session-id"];
    let transport = id && sessions.get(id);
    if (!transport) {
      if (id) return fail(404, "unknown or expired session");
      if (body?.method !== "initialize") return fail(400, "start with initialize");
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => sessions.set(sid, transport),
      });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      await hallServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) fail(500, err.message);
  }
}).listen(PORT, () => console.log(`Demo MCP server on http://localhost:${PORT}/mcp (${SESSIONS ? "sessions" : "stateless"}, wrapping ${APP_URL})`));
