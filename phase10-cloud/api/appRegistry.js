// Phase 10 #4: the connected apps - other applications whose data the agent
// can read through their APIs. Each app is an entry in Redis, not code: adding,
// changing or removing one is an admin request (adminApi.js, `npm run app`),
// with no deployment of this service.
//
// An entry, as given by the admin:
//   { name, description, openapi, callers, user?, token?, dataLevel?, timezone?, timeoutMs?, allow?, examples? }
// - description: what the router and planner read to decide when to ask this app
// - openapi: the URL of the app's OpenAPI 3 file; read at registration, so the
//   app's GET operations are stored with the entry (openapiTools.js)
// - token: sent as "Authorization: Bearer <token>"; stored encrypted
// - dataLevel: public | internal | confidential (dataPolicy.js, default internal)
// - callers: who may ask this app's data - "web" (the web chat) and/or the
//   names of /api/ask apps (APP_API_KEYS). Required: an app's data is not
//   open to every user of this service by default (appAccess.js).
// - user: "none" (default) | "optional" | "required" - pass the caller's
//   logged-in user to the app (header X-User-Token), so the app answers as
//   that user may see it; "required": not used without one.
// - whoami: optional - the id of the app's operation that says who the
//   logged-in user is ("me"). A question with "I", "my", "me" that the plan
//   sends to this app also gets that call, so "Do I have pending dues?" is
//   answered for the asking user (apps.js).
//
// Safety does not depend on the entry: only GET, only the operations in the
// stored list, only https (http on this machine for tests) - apps.js.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { redis } from "./sessionStore.js";
import { APPS_KEY, APP_SECRETS_KEY } from "./config.js";
import { readOpenApi } from "./openapiTools.js";

export const DATA_LEVELS = ["public", "internal", "confidential"];
export const USER_MODES = ["none", "optional", "required"];
const DEFAULT_TIMEOUT_MS = 60000; // a free Render backend can take ~50 s to wake up
const MAX_OPENAPI_BYTES = 500000;

export class AppConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// https anywhere; plain http only to this machine (local tests).
export function checkUrl(url, what = "URL") {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new AppConfigError(`${what} is not a valid URL: ${url}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new AppConfigError(`${what} must use https: ${url}`);
  if (u.username || u.password) throw new AppConfigError(`${what} must not contain a user name or password`);
  return u;
}

// --- token encryption (AES-256-GCM, key from APP_SECRETS_KEY) ---
function secretsKey() {
  const key = APP_SECRETS_KEY ? Buffer.from(APP_SECRETS_KEY, "base64") : null;
  if (!key || key.length !== 32) throw new AppConfigError("APP_SECRETS_KEY must be set to 32 random bytes in base64 to store app tokens", 500);
  return key;
}
function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretsKey(), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob) {
  const [iv, tag, data] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", secretsKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// --- reading the registry: every question needs it, so it is kept briefly ---
// Each function instance re-reads at most every 30 s; a change made through
// the admin API on another instance shows up within that time.
const CACHE_MS = 30000;
let cache = null;

export async function listApps() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.apps;
  let apps = [];
  try {
    const raw = await redis.hGetAll(APPS_KEY);
    apps = Object.values(raw)
      .map((v) => JSON.parse(v))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    // A broken registry must not break the chat: answer without apps.
    console.error(`[apps] could not read the registry: ${err.message}`);
    return cache?.apps ?? [];
  }
  cache = { at: Date.now(), apps };
  return apps;
}

export async function getApp(name) {
  return (await listApps()).find((a) => a.name === name) ?? null;
}

export function appToken(app) {
  return app.tokenEnc ? decrypt(app.tokenEnc) : null;
}

// What the admin API shows: everything except the token.
export function publicView(app) {
  const { tokenEnc, ...rest } = app;
  return { ...rest, hasToken: Boolean(tokenEnc) };
}

async function fetchOpenApi(url, token, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AppConfigError(`could not fetch the OpenAPI file: ${err.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : err.message}`, 502);
  }
  if (!res.ok) throw new AppConfigError(`the OpenAPI file answered ${res.status}${res.status === 401 || res.status === 403 ? " - check the token" : ""}`, 502);
  const text = await res.text();
  if (text.length > MAX_OPENAPI_BYTES) throw new AppConfigError(`the OpenAPI file is over ${MAX_OPENAPI_BYTES / 1000} KB`, 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppConfigError("the OpenAPI file is not JSON", 502);
  }
}

function validate(input, existing) {
  const e = { ...input };
  if (!/^[a-z0-9-]{1,30}$/.test(e.name ?? "")) throw new AppConfigError('name: 1-30 characters, a-z 0-9 and "-"');
  if (typeof e.description !== "string" || e.description.trim().length < 10) throw new AppConfigError("description: say in a sentence what data the app has (the router reads it)");
  e.description = e.description.trim().slice(0, 300);
  checkUrl(e.openapi, "openapi");
  e.dataLevel = e.dataLevel ?? existing?.dataLevel ?? "internal";
  if (!DATA_LEVELS.includes(e.dataLevel)) throw new AppConfigError(`dataLevel: one of ${DATA_LEVELS.join(", ")}`);
  e.callers = e.callers ?? existing?.callers;
  if (!Array.isArray(e.callers) || !e.callers.length || !e.callers.every((c) => /^[a-z0-9-]{1,30}$/.test(c))) {
    throw new AppConfigError('callers: who may ask this app - "web" for the web chat and/or /api/ask app names, e.g. ["masjid"]');
  }
  e.user = e.user ?? existing?.user ?? "none";
  if (!USER_MODES.includes(e.user)) throw new AppConfigError(`user: one of ${USER_MODES.join(", ")}`);
  if (e.whoami !== undefined && (typeof e.whoami !== "string" || !e.whoami)) throw new AppConfigError("whoami: an operation id from the app's OpenAPI file");
  if (e.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: e.timezone });
    } catch {
      throw new AppConfigError(`timezone: unknown "${e.timezone}" (use names like Asia/Kolkata)`);
    }
  }
  e.timeoutMs = Number(e.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!(e.timeoutMs >= 1000 && e.timeoutMs <= 120000)) throw new AppConfigError("timeoutMs: 1000 to 120000");
  if (e.allow !== undefined && !(Array.isArray(e.allow) && e.allow.every((a) => typeof a === "string"))) throw new AppConfigError('allow: a list like ["GET /ai/today-duty"]');
  if (e.examples !== undefined && !(Array.isArray(e.examples) && e.examples.length <= 10 && e.examples.every((q) => typeof q === "string"))) {
    throw new AppConfigError("examples: up to 10 questions");
  }
  if (e.token !== undefined && (typeof e.token !== "string" || !e.token.trim())) throw new AppConfigError("token: a non-empty string");
  return e;
}

// Add or replace an app. A token left out keeps the stored one, so the
// description or examples can change without handing the token over again.
export async function saveApp(input) {
  const existing = await rawApp(input?.name);
  const e = validate(input, existing);
  const token = e.token ?? (existing?.tokenEnc ? decrypt(existing.tokenEnc) : null);
  const { baseUrl, title, operations, skipped } = await readSpec(e.openapi, token, e.timeoutMs, e.allow);
  checkUrl(baseUrl, "the OpenAPI servers[0].url");
  if (e.whoami && !operations.some((o) => o.id === e.whoami)) {
    throw new AppConfigError(`whoami: "${e.whoami}" is not one of the app's GET operations (${operations.map((o) => o.id).join(", ")})`);
  }
  const entry = {
    name: e.name,
    description: e.description,
    openapi: e.openapi,
    baseUrl,
    title,
    dataLevel: e.dataLevel,
    callers: e.callers,
    user: e.user,
    ...(e.whoami ? { whoami: e.whoami } : {}),
    ...(e.timezone ? { timezone: e.timezone } : {}),
    timeoutMs: e.timeoutMs,
    ...(e.allow ? { allow: e.allow } : {}),
    examples: e.examples ?? [],
    operations,
    ...(token ? { tokenEnc: encrypt(token) } : {}),
    updatedAt: new Date().toISOString(),
  };
  await redis.hSet(APPS_KEY, entry.name, JSON.stringify(entry));
  cache = null;
  return { app: publicView(entry), skipped };
}

async function readSpec(openapiUrl, token, timeoutMs, allow) {
  const doc = await fetchOpenApi(openapiUrl, token, timeoutMs);
  try {
    return readOpenApi(doc, { openapiUrl, allow });
  } catch (err) {
    throw new AppConfigError(`OpenAPI file: ${err.message}`, 422);
  }
}

async function rawApp(name) {
  if (typeof name !== "string") return null;
  const v = await redis.hGet(APPS_KEY, name);
  return v ? JSON.parse(v) : null;
}

// Read the app's OpenAPI file again - after the app added or changed an endpoint.
export async function refreshApp(name) {
  const existing = await rawApp(name);
  if (!existing) throw new AppConfigError(`no app named "${name}"`, 404);
  const { tokenEnc, operations, baseUrl, title, updatedAt, ...config } = existing;
  return saveApp(config);
}

export async function removeApp(name) {
  const removed = await redis.hDel(APPS_KEY, name);
  cache = null;
  if (!removed) throw new AppConfigError(`no app named "${name}"`, 404);
}
