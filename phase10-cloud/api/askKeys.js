// Phase 10 #4: the /api/ask keys in Redis, so a new app needs no deployment.
// Before, every key was in APP_API_KEYS (config.js): one more app meant
// editing that env var on Vercel and deploying again. Now a key is made with
// `npm run app -- askkey new <app>` and works at once; taking it back works
// at once too. APP_API_KEYS is still read, so keys set there keep working.
//
// Only a SHA-256 hash of each key is stored, never the key: the service
// only has to recognise a key, never send it anywhere (unlike an app's
// token, which it must send, so that is encrypted - appRegistry.js). Someone
// who reads Redis gets hashes, which cannot be turned back into keys.
//
//   Redis hash ASK_KEYS_KEY ("ask:keys"):
//     <sha256 hex of the key>  ->  { name, hint, createdAt }
//   name: the app (the caller in appAccess.js, the daily limit, conversations)
//   hint: the key's last 4 characters, so a list can say which key is which
//
// An app can have more than one key, so a key can be replaced without a gap:
// make the new one, put it in the app, then revoke the old one.
import { randomBytes, createHash } from "node:crypto";
import { redis } from "./sessionStore.js";
import { ASK_KEYS_KEY, APP_API_KEYS } from "./config.js";
import { AppConfigError } from "./appRegistry.js";

// Callers that are not /api/ask apps - a key with one of these names would
// get that caller's connected apps (server.js, appAccess.js).
const RESERVED = ["web", "command", "local"];
const NAME = /^[a-z0-9-]{1,30}$/;
const MIN_KEY_CHARS = 24;

const hashOf = (key) => createHash("sha256").update(String(key)).digest("hex");
// A short id for a key in lists and in `revoke` - the start of its hash.
const idOf = (hash) => hash.slice(0, 10);

function checkName(name) {
  if (!NAME.test(name ?? "")) throw new AppConfigError('name: 1-30 characters, a-z 0-9 and "-"');
  if (RESERVED.includes(name)) throw new AppConfigError(`name: "${name}" is reserved (${RESERVED.join(", ")})`);
}

// Which app a key belongs to, or null. One Redis read per request: the key's
// hash is the field name, so nothing is compared one by one and a revoked key
// stops working on the next request.
export async function appForKey(key) {
  const v = await redis.hGet(ASK_KEYS_KEY, hashOf(key));
  return v ? JSON.parse(v).name : null;
}

// Whether any key exists at all - with none, and no access code, the Mac's
// /api/ask stays open (askApi.js).
export async function hasAskKeys() {
  return APP_API_KEYS.length > 0 || (await redis.hLen(ASK_KEYS_KEY)) > 0;
}

// A new key for an app. `key` given: store that one instead (to move a key
// from APP_API_KEYS here, so the app does not have to change it). The key is
// returned once and not kept.
export async function createAskKey(name, key) {
  checkName(name);
  if (key !== undefined && (typeof key !== "string" || key.length < MIN_KEY_CHARS || /\s/.test(key))) {
    throw new AppConfigError(`key: at least ${MIN_KEY_CHARS} characters, no spaces`);
  }
  key = key ?? `ak_${randomBytes(24).toString("base64url")}`;
  const hash = hashOf(key);
  const existing = await redis.hGet(ASK_KEYS_KEY, hash);
  if (existing && JSON.parse(existing).name !== name) throw new AppConfigError("that key is already stored for another app", 409);
  const entry = { name, hint: key.slice(-4), createdAt: new Date().toISOString() };
  await redis.hSet(ASK_KEYS_KEY, hash, JSON.stringify(entry));
  return { key, id: idOf(hash), ...entry };
}

// The keys, without the keys: app, id, last 4 characters, when made - and the
// app names still in APP_API_KEYS, which can only change on Vercel.
export async function listAskKeys() {
  const raw = await redis.hGetAll(ASK_KEYS_KEY);
  const keys = Object.entries(raw)
    .map(([hash, v]) => ({ id: idOf(hash), ...JSON.parse(v) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
  return { keys, fromEnv: APP_API_KEYS.map((a) => a.name) };
}

// Take back keys: by id (one key) or by app name (all of that app's keys).
export async function revokeAskKeys(idOrName) {
  const raw = await redis.hGetAll(ASK_KEYS_KEY);
  const hashes = Object.entries(raw)
    .filter(([hash, v]) => idOf(hash) === idOrName || JSON.parse(v).name === idOrName)
    .map(([hash]) => hash);
  if (!hashes.length) throw new AppConfigError(`no stored key with id or app "${idOrName}"`, 404);
  await redis.hDel(ASK_KEYS_KEY, hashes);
  const fromEnv = APP_API_KEYS.some((a) => a.name === idOrName);
  return { revoked: hashes.map(idOf), ...(fromEnv ? { note: `"${idOrName}" also has a key in APP_API_KEYS - remove it there (Vercel) to stop it` } : {}) };
}
