# Connected apps

The agent can answer questions from other applications' live data - "Who is on
duty today?", "Which members have pending dues?" - with no code per app in this
service. An app is an entry in the registry (Redis), added with one command and
no deployment. See `../README.md`, step 10d.4.

```
npm run app -- add apps/<app>.json      (from phase10-cloud/api: npm run app -- add ../apps/<app>.json)
npm run app -- list | refresh <name> | remove <name> | try "<question>"
```

## What an app needs on its side

Three small additions to the app's own backend. `../examples/demo-app/server.js`
is a complete, runnable example.

### 1. Read-only endpoints for the AI

Separate from the endpoints the app's screens use, so a UI change never breaks
the AI, and returning only what the AI needs - leave out bank details, phone
numbers, password hashes and anything else that should not reach a model.

```js
// Express + Postgres (node-postgres)
const ai = express.Router();
ai.use(requireAiToken);                       // step 2

ai.get("/today-duty", async (req, res) => {
  const date = req.query.date ?? todayInKolkata();
  const { rows } = await pool.query(
    "SELECT m.name, d.role FROM duties d JOIN members m ON m.id = d.member_id WHERE d.date = $1",
    [date]
  );
  res.json({ date, onDuty: rows });
});

ai.get("/pending-dues", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT m.name, d.month, d.amount FROM dues d JOIN members m ON m.id = d.member_id WHERE d.status = 'pending' ORDER BY d.month"
  );
  res.json(rows);
});

ai.get("/openapi.json", (req, res) => res.json(OPENAPI));   // step 3
app.use("/api/ai", ai);
```

Keep them GET, and keep each answer small (the agent puts at most ~6,000
characters of one response in the prompt): filter and limit in SQL - a date
range, a status, the latest 20 - rather than returning whole tables.

### 2. An access token for them

One long random token, kept as a secret on the app's server (for example
`MASJID_AI_TOKEN` on Render), accepted only on `/api/ai/*`. The normal user
login stays as it is.

```js
import { timingSafeEqual, createHash } from "node:crypto";
const digest = (s) => createHash("sha256").update(String(s)).digest();

function requireAiToken(req, res, next) {
  const given = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (!process.env.MASJID_AI_TOKEN || !timingSafeEqual(digest(given), digest(process.env.MASJID_AI_TOKEN))) {
    return res.status(401).json({ error: "access token required" });
  }
  next();
}
```

Make a token with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
Why not the admin username and password: the token can only read these
endpoints, survives a password change, and can be replaced in a minute if it
leaks.

### 3. `openapi.json` describing them

What the agent reads to know which calls exist. The `summary` and parameter
`description`s are what the model chooses by - write them for a reader who
knows nothing about the app.

```json
{
  "openapi": "3.0.3",
  "info": { "title": "Masjid - AI read-only API", "version": "1.0.0" },
  "servers": [{ "url": "/api" }],
  "paths": {
    "/ai/today-duty": {
      "get": {
        "operationId": "duty_on_date",
        "summary": "Who is on duty on one day, with their roles",
        "parameters": [
          { "name": "date", "in": "query", "required": false, "description": "Day as YYYY-MM-DD; today if left out", "schema": { "type": "string", "format": "date" } }
        ]
      }
    },
    "/ai/pending-dues": {
      "get": { "operationId": "pending_dues", "summary": "Members with unpaid dues: name, month, amount" }
    }
  }
}
```

`servers[0].url` may be relative ("/api" - relative to where the file is) or a
full https URL. Only GET operations are used; at most 15 per app.

## The app's entry here

`masjid.example.json` - copy to `masjid.json`, put the token in `../.env` as
`MASJID_AI_TOKEN=...`, then `npm run app -- add ../apps/masjid.json`.

| Field | |
|---|---|
| `name` | a-z 0-9 -, shown as "<name> API" under answers |
| `description` | what data the app has - the router and planner decide by it |
| `openapi` | URL of the app's OpenAPI file (https; http only on this machine) |
| `token` | `"$ENV_NAME"` reads it from `../.env`; stored encrypted |
| `dataLevel` | `public`, `internal` (default) or `confidential` - see 10d.3; confidential apps only work with a local model |
| `timezone` | the app's time zone, so "today" is the app's day (e.g. `Asia/Kolkata`) |
| `timeoutMs` | per call, default 60000 (a free Render backend can take ~50 s to wake up) |
| `allow` | optional `["GET /ai/today-duty", ...]` - use only these operations |
| `examples` | 3-5 questions users ask - kept with the app for testing |

After the app adds or changes an endpoint in its `openapi.json`:
`npm run app -- refresh <name>`.
