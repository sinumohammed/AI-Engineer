// Phase 10e: OpenAPI description of this service's own usage, read-only, so
// the Command Center's agents can answer "how many questions today?", "what
// did masjid cost this week?" through the ordinary connected-apps connector
// (apps.js) - registered like any app (../apps/usage.json), with callers
// ["command"]: only the Command Center, which holds the dashboard key, may
// ask. The summaries and descriptions are what the planner chooses by.
// Served at GET /api/admin/usage/openapi.json (adminApi.js).
const days = { name: "days", in: "query", required: false, description: "How many days back, counted from now (1 = the last 24 hours, 7 = the last week, 30 = the last month). Default 30", schema: { type: "integer", minimum: 1, maximum: 365 } };
const app = { name: "app", in: "query", required: false, description: 'Only this app: "web" (the web chat), "command" (the Command Center), or a connected app\'s name such as "masjid"', schema: { type: "string" } };

export const USAGE_OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "AI service usage - read-only",
    version: "1.0.0",
    description:
      "How this AI service is used: questions asked, by which app (the web chat, the Command Center, connected apps such as masjid) " +
      "and which user inside an app, tokens, estimated cost in US dollars, errors, response times, agents and models used. " +
      "Estimated cost is what the use would cost on the providers' paid tiers; on the free tiers the real bill is $0. " +
      "Days are counted in UTC. Users inside apps are codes (member:MR001, guest:..., admin), never names.",
  },
  servers: [{ url: "/api/admin" }],
  paths: {
    "/usage/summary": {
      get: {
        operationId: "usage_summary",
        summary: "Totals for a period: questions (and how many today), errors, tokens, estimated cost, typical and slow response times; per app: questions, users, voice, files, cost, last used; per model and per agent",
        parameters: [days],
      },
    },
    "/usage/users": {
      get: {
        operationId: "usage_users",
        summary: "Users inside apps, most active first: user code, app, questions, errors, estimated cost, last used - for \"who uses it most\", \"top users\"",
        parameters: [days, app],
      },
    },
    "/usage/daily": {
      get: {
        operationId: "usage_daily",
        summary: "Questions and estimated cost per day, per app - for trends, \"yesterday\", \"this week day by day\"",
        parameters: [days, app],
      },
    },
    "/usage/recent": {
      get: {
        operationId: "usage_recent",
        summary: "The latest requests, newest first: time, app, kind (chat, ask, voice, file, speech), agents, tokens, cost, time taken, ok or the error - for \"what failed\", \"the last requests\"",
        parameters: [{ name: "limit", in: "query", required: false, description: "How many, 1-30. Default 10", schema: { type: "integer", minimum: 1, maximum: 30 } }],
      },
    },
    "/usage/errors": {
      get: {
        operationId: "usage_errors",
        summary: "What failed, newest first: requests that ended in an error (with the error message) and answered questions where a call to a connected app failed - for \"what failed\", \"any errors today\", \"why did masjid fail\"",
        parameters: [days, app],
      },
    },
    "/usage/app-calls": {
      get: {
        operationId: "usage_app_calls",
        summary: "Calls the agents made to connected apps' APIs (e.g. masjid today_duty): calls, failures, average time",
        parameters: [days],
      },
    },
  },
};
