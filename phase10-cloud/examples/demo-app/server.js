// Phase 10 #4: a small demo app for testing connected apps - what a real
// app adds to its own backend so the agent can read it:
//   - read-only endpoints under /api/ai/, returning only what the AI needs
//   - an access token for them ("Authorization: Bearer <token>")
//   - /api/ai/openapi.json describing them
// Made-up data in the shape of a community hall: a volunteer duty roster,
// members, monthly dues, announcements. Dates are relative to today, so
// "who is on duty today?" always has an answer. No packages: node:http only.
//
//   node server.js     (DEMO_APP_PORT, default 4010; DEMO_APP_TOKEN, default demo-token)
//   DEMO_APP_DELAY_MS=5000 node server.js   answers slowly, to test time limits
//
// Roles, as a real app would check its own logged-in user: the AI service
// passes the caller's user in X-User-Token. Here a demo token is "admin" or
// "member:M-101"; a member sees only their own dues (403 for someone else's
// details). No X-User-Token: everything, as before.
import { createServer } from "node:http";

const PORT = Number(process.env.DEMO_APP_PORT ?? 4010);
const TOKEN = process.env.DEMO_APP_TOKEN ?? "demo-token";
const DELAY_MS = Number(process.env.DEMO_APP_DELAY_MS ?? 0);
const TZ = "Asia/Kolkata";

const MEMBERS = [
  { id: "M-101", name: "Aisha Rahman", joined: "2021-03-14", phoneOnFile: true },
  { id: "M-102", name: "Bilal Qureshi", joined: "2019-08-02", phoneOnFile: true },
  { id: "M-103", name: "Fatima Noor", joined: "2023-01-20", phoneOnFile: false },
  { id: "M-104", name: "Hamza Siddiqui", joined: "2020-11-11", phoneOnFile: true },
  { id: "M-105", name: "Mariam Yusuf", joined: "2022-06-30", phoneOnFile: true },
  { id: "M-106", name: "Omar Farooq", joined: "2018-04-09", phoneOnFile: false },
];
const ROLES = ["Opening and closing", "Cleaning"];

const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

// Two volunteers a day, rotating through the members.
function duty(iso) {
  const n = dayNumber(iso);
  return { date: iso, weekday: weekday(iso), onDuty: ROLES.map((role, i) => ({ role, memberId: MEMBERS[(n * 2 + i) % MEMBERS.length].id, name: MEMBERS[(n * 2 + i) % MEMBERS.length].name })) };
}

function dues() {
  const month = todayIso().slice(0, 7);
  const prev = addDays(`${month}-01`, -1).slice(0, 7);
  return [
    ...MEMBERS.map((m, i) => ({ memberId: m.id, name: m.name, month: prev, amount: 500, currency: "INR", status: "paid" })),
    ...MEMBERS.map((m, i) => ({ memberId: m.id, name: m.name, month, amount: 500, currency: "INR", status: [1, 3].includes(i) ? "pending" : "paid" })),
    { memberId: "M-106", name: "Omar Farooq", month: prev, amount: 1200, currency: "INR", status: "pending", note: "hall booking" },
  ];
}

function announcements() {
  const t = todayIso();
  return [
    { date: addDays(t, -1), title: "Hall closed for repairs on Saturday", text: "The main hall is closed this Saturday from 9 am to 5 pm for roof repairs." },
    { date: addDays(t, -6), title: "Monthly dues reminder", text: "Please pay this month's dues of 500 INR by the 10th." },
    { date: addDays(t, -20), title: "New volunteer roster", text: "The duty roster now has two volunteers a day: opening and closing, and cleaning." },
  ];
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Community Hall - AI read-only API", version: "1.0.0" },
  servers: [{ url: "/api" }],
  paths: {
    "/ai/me": {
      get: { operationId: "me", summary: "The asking user: their member record, own dues and upcoming duty days (admin: just the role)" },
    },
    "/ai/duty": {
      get: {
        operationId: "duty_on_date",
        summary: "Volunteers on duty on one day, with their roles",
        parameters: [{ name: "date", in: "query", required: false, description: "Day as YYYY-MM-DD; today if left out", schema: { type: "string", format: "date" } }],
      },
    },
    "/ai/schedule": {
      get: {
        operationId: "duty_schedule",
        summary: "The duty roster for a range of days (at most 31)",
        parameters: [
          { name: "from", in: "query", required: true, description: "First day, YYYY-MM-DD", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", required: true, description: "Last day, YYYY-MM-DD", schema: { type: "string", format: "date" } },
        ],
      },
    },
    "/ai/members": {
      get: {
        operationId: "list_members",
        summary: "Members: id, name, date joined",
        parameters: [{ name: "search", in: "query", required: false, description: "Part of a name", schema: { type: "string" } }],
      },
      post: { operationId: "add_member", summary: "Add a member (not for the AI)" },
    },
    "/ai/members/{id}": {
      get: {
        operationId: "member_details",
        summary: "One member, with their dues and upcoming duty days",
        parameters: [{ name: "id", in: "path", required: true, description: "Member id like M-101", schema: { type: "string" } }],
      },
    },
    "/ai/dues": {
      get: {
        operationId: "list_dues",
        summary: "Monthly dues per member, paid or pending (this month and last)",
        parameters: [{ name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending", "paid"] } }],
      },
    },
    "/ai/announcements": {
      get: { operationId: "announcements", summary: "Recent announcements, newest first", parameters: [{ $ref: "#/components/parameters/Limit" }] },
    },
  },
  components: { parameters: { Limit: { name: "limit", in: "query", required: false, description: "How many, default 5", schema: { type: "integer" } } } },
};

function viewer(req) {
  const t = req.headers["x-user-token"];
  if (!t) return { all: true };
  if (t === "admin") return { all: true, admin: true };
  const m = t.match(/^member:(M-\d+)$/);
  return m ? { memberId: m[1] } : { invalid: true };
}

function route(path, q, who) {
  if (path === "/api/ai/openapi.json") return [200, OPENAPI];
  if (path === "/api/ai/me") {
    if (!who.memberId) return [200, { role: who.admin ? "admin" : "anonymous" }];
    const m = MEMBERS.find((x) => x.id === who.memberId);
    const t = todayIso();
    const upcoming = Array.from({ length: 14 }, (_, i) => duty(addDays(t, i))).filter((d) => d.onDuty.some((o) => o.memberId === m.id)).map((d) => ({ date: d.date, weekday: d.weekday }));
    return [200, { role: "member", id: m.id, name: m.name, dues: dues().filter((d) => d.memberId === m.id), upcomingDuty: upcoming }];
  }
  if (path === "/api/ai/duty") {
    const date = q.get("date") ?? todayIso();
    return isDate(date) ? [200, duty(date)] : [400, { error: "date must be YYYY-MM-DD" }];
  }
  if (path === "/api/ai/schedule") {
    const from = q.get("from");
    const to = q.get("to");
    if (!isDate(from) || !isDate(to)) return [400, { error: "from and to must be YYYY-MM-DD" }];
    const days = dayNumber(to) - dayNumber(from) + 1;
    if (days < 1 || days > 31) return [400, { error: "1 to 31 days" }];
    return [200, { from, to, days: Array.from({ length: days }, (_, i) => duty(addDays(from, i))) }];
  }
  if (path === "/api/ai/members") {
    const s = (q.get("search") ?? "").toLowerCase();
    return [200, MEMBERS.filter((m) => m.name.toLowerCase().includes(s)).map(({ phoneOnFile, ...m }) => m)];
  }
  const member = path.match(/^\/api\/ai\/members\/([^/]+)$/);
  if (member) {
    const m = MEMBERS.find((x) => x.id === decodeURIComponent(member[1]));
    if (!m) return [404, { error: "no such member" }];
    if (!who.all && who.memberId !== m.id) return [403, { error: "members can only see their own details" }];
    const t = todayIso();
    const upcoming = Array.from({ length: 14 }, (_, i) => duty(addDays(t, i))).filter((d) => d.onDuty.some((o) => o.memberId === m.id)).map((d) => ({ date: d.date, weekday: d.weekday, role: d.onDuty.find((o) => o.memberId === m.id).role }));
    return [200, { ...m, dues: dues().filter((d) => d.memberId === m.id), upcomingDuty: upcoming }];
  }
  if (path === "/api/ai/dues") {
    const status = q.get("status");
    return [200, dues().filter((d) => (!status || d.status === status) && (who.all || d.memberId === who.memberId))];
  }
  if (path === "/api/ai/announcements") return [200, announcements().slice(0, Number(q.get("limit") ?? 5) || 5)];
  return [404, { error: "not found" }];
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "access token required" });
  if (req.method !== "GET") return send(405, { error: "read-only" });
  const who = viewer(req);
  if (who.invalid) return send(401, { error: "unknown user" });
  if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  send(...route(url.pathname, url.searchParams, who));
}).listen(PORT, () => console.log(`Demo app on http://localhost:${PORT}/api (token "${TOKEN}")`));
