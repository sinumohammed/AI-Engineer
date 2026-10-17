// Phase 10 #4: an app's OpenAPI file -> the read-only operations the agent may
// call. Read once when the app is registered (appRegistry.js) and stored with
// it, so a question never waits for the file. Only GET operations are kept:
// whatever the file lists, this connector never changes data in an app.
//
// Kept per operation: an id, the path, what it is for, and its parameters
// (path and query only, with type, enum and description) - what the planner
// (apps.js) needs to choose a call and fill it in.

const MAX_OPERATIONS = 15; // each one costs prompt tokens on every planned question
const MAX_TEXT = 300;

const short = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "");

// "#/components/parameters/Date" -> that object, one level (enough for parameters).
function deref(doc, obj) {
  if (!obj?.$ref?.startsWith("#/")) return obj;
  return obj.$ref.slice(2).split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc) ?? null;
}

// "/members/{id}" -> "members_id" when the file gives no operationId.
const idFromPath = (path) => path.replace(/[{}]/g, "").split("/").filter(Boolean).join("_").replace(/[^A-Za-z0-9_]/g, "_") || "root";

// `allow`: optional ["GET /members", ...] from the app's config - only these are kept.
export function readOpenApi(doc, { openapiUrl, allow } = {}) {
  if (!doc || typeof doc !== "object" || !String(doc.openapi ?? "").startsWith("3.") || typeof doc.paths !== "object") {
    throw new Error("not an OpenAPI 3 document (needs \"openapi\": \"3.x\" and \"paths\")");
  }
  const server = doc.servers?.[0]?.url;
  if (!server) throw new Error("the OpenAPI file lists no servers[0].url - the address the API is called at");
  // A relative server ("/api") is relative to where the file was fetched.
  const baseUrl = new URL(server, openapiUrl).href.replace(/\/$/, "");

  const allowed = allow?.length ? new Set(allow.map((a) => a.replace(/\s+/g, " ").trim().toUpperCase())) : null;
  const operations = [];
  const skipped = { notGet: 0, notAllowed: 0, overLimit: 0 };
  const ids = new Set();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item ?? {})) {
      if (["parameters", "summary", "description", "servers", "$ref"].includes(method)) continue;
      if (method !== "get") {
        skipped.notGet++;
        continue;
      }
      if (allowed && !allowed.has(`GET ${path}`.toUpperCase())) {
        skipped.notAllowed++;
        continue;
      }
      if (operations.length >= MAX_OPERATIONS) {
        skipped.overLimit++;
        continue;
      }
      const op = item.get;
      let id = (op.operationId ?? idFromPath(path)).replace(/[^A-Za-z0-9_]/g, "_");
      while (ids.has(id)) id += "_";
      ids.add(id);
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .map((p) => deref(doc, p))
        .filter((p) => p && (p.in === "path" || p.in === "query") && typeof p.name === "string")
        .map((p) => {
          const schema = deref(doc, p.schema) ?? {};
          return {
            name: p.name,
            in: p.in,
            required: p.in === "path" || Boolean(p.required),
            type: schema.type ?? "string",
            ...(schema.format ? { format: schema.format } : {}),
            ...(Array.isArray(schema.enum) ? { enum: schema.enum.map(String).slice(0, 20) } : {}),
            description: short(p.description ?? schema.description),
          };
        });
      // Every {name} in the path must be a parameter, or the call cannot be built.
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
        if (!params.some((p) => p.in === "path" && p.name === name)) params.push({ name, in: "path", required: true, type: "string", description: "" });
      }
      operations.push({ id, path, summary: short(op.summary ?? op.description) || `GET ${path}`, description: short(op.summary ? op.description : ""), params });
    }
  }
  if (!operations.length) throw new Error(`no GET operations to use (${skipped.notGet} other methods${allowed ? `, ${skipped.notAllowed} not in "allow"` : ""})`);
  return { baseUrl, title: short(doc.info?.title), operations, skipped };
}

// One line per operation, for the planner's prompt:
//   masjid.today_duty - GET /ai/today-duty - Who is on duty today. Params: date (query, string, date, optional): ...
// An MCP app's tool (mcpTools.js) has no method or path, and its parameters are arguments:
//   hall.duty_on_date - tool - Volunteers on duty on one day. Params: date (string, optional): ...
export function describeOperation(appName, op) {
  const params = op.params.length
    ? " Params: " +
      op.params
        .map((p) => `${p.name} (${p.in === "arg" ? "" : `${p.in}, `}${p.type}${p.format ? `, ${p.format}` : ""}${p.enum ? `, one of ${p.enum.join("|")}` : ""}, ${p.required ? "required" : "optional"})${p.description ? `: ${p.description}` : ""}`)
        .join("; ")
    : "";
  return `${appName}.${op.id} - ${op.tool ? "tool" : `GET ${op.path}`} - ${op.summary}${op.description ? ` ${op.description}` : ""}.${params}`;
}
