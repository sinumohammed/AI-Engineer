// Each /api/ask app's own switch and limits, set from the Command Center
// (admin key only) - no deployment. Before, every app had the same daily
// limit, APP_DAILY_LIMIT, which only a redeploy could change.
//
//   Redis hash APP_LIMITS_KEY ("apps:limits"):
//     <app>  ->  { paused, daily, monthly, updatedAt }
//   paused:  true = the app's questions are refused at once (and its voice input)
//   daily:   questions per day (UTC), 0 = no daily limit; no entry = APP_DAILY_LIMIT
//   monthly: questions per calendar month (UTC), 0 = no monthly limit
//
// The counts are Redis counters per app and day / month. A question that is
// refused is not counted, so "used" is what was answered (or tried and failed).
// These sit on top of the app's own limits for its users (the masjid's
// 4 a day per member): this is the most the whole app may ask.
import { redis } from "./sessionStore.js";
import { APP_DAILY_LIMIT, APP_LIMITS_KEY, APP_API_KEYS } from "./config.js";
import { AppConfigError } from "./appRegistry.js";
import { listAskKeys } from "./askKeys.js";

const MAX_LIMIT = 1_000_000;
const dayKey = (app, now = new Date()) => `app:${app}:asks:${now.toISOString().slice(0, 10)}`;
const monthKey = (app, now = new Date()) => `app:${app}:asks:${now.toISOString().slice(0, 7)}`;

const defaults = () => ({ paused: false, daily: APP_DAILY_LIMIT, monthly: 0, updatedAt: null });

export async function limitsOf(app) {
  const raw = await redis.hGet(APP_LIMITS_KEY, app);
  return { ...defaults(), ...(raw ? JSON.parse(raw) : {}) };
}

// One question more for `app`, if it may ask: { ok: true } or { ok: false,
// status, error }. Counted in one MULTI, and taken back when over a limit.
export async function takeAppQuestion(app) {
  let limits;
  try {
    limits = await limitsOf(app);
  } catch (err) {
    // Redis down: answer rather than lock every app out.
    console.error(`[appLimits] could not read ${app}'s limits, not limiting: ${err.message}`);
    return { ok: true };
  }
  if (limits.paused) return { ok: false, status: 403, error: "This app's assistant is paused by the AI service's admin - please try again later." };
  const now = new Date();
  const [day, month] = [dayKey(app, now), monthKey(app, now)];
  let usedToday;
  let usedMonth;
  try {
    [usedToday, , usedMonth] = await redis.multi().incr(day).expire(day, 60 * 60 * 48).incr(month).expire(month, 60 * 60 * 24 * 40).exec();
  } catch (err) {
    console.error(`[appLimits] counting failed, not limiting: ${err.message}`);
    return { ok: true };
  }
  const overDay = limits.daily > 0 && usedToday > limits.daily;
  const overMonth = limits.monthly > 0 && usedMonth > limits.monthly;
  if (!overDay && !overMonth) return { ok: true };
  await redis.multi().decr(day).decr(month).exec().catch(() => {});
  return overMonth
    ? { ok: false, status: 429, error: `This app's monthly limit of ${limits.monthly} question${limits.monthly === 1 ? "" : "s"} is used up - it resets on the 1st (UTC).` }
    : { ok: false, status: 429, error: `This app's daily limit of ${limits.daily} question${limits.daily === 1 ? "" : "s"} is used up - it resets at midnight UTC.` };
}

// Voice input is not a question, but it spends the same quota: refused when
// the app is paused or has nothing left today / this month.
export async function appMayTranscribe(app) {
  try {
    const limits = await limitsOf(app);
    if (limits.paused) return { ok: false, status: 403, error: "This app's assistant is paused by the AI service's admin." };
    const [usedToday, usedMonth] = (await redis.mGet([dayKey(app), monthKey(app)])).map((v) => Number(v ?? 0));
    if ((limits.daily > 0 && usedToday >= limits.daily) || (limits.monthly > 0 && usedMonth >= limits.monthly)) {
      return { ok: false, status: 429, error: "This app's questions are used up for now." };
    }
  } catch (err) {
    console.error(`[appLimits] could not check ${app} for voice, allowing: ${err.message}`);
  }
  return { ok: true };
}

// Every app that can ask (a stored key, or one in APP_API_KEYS), with its
// limits and what it used today and this month - the Command Center's list.
export async function appLimitsReport() {
  const { keys, fromEnv } = await listAskKeys();
  const apps = [...new Set([...keys.map((k) => k.name), ...fromEnv, ...(await redis.hKeys(APP_LIMITS_KEY))])].sort();
  const counts = apps.length ? await redis.mGet(apps.flatMap((a) => [dayKey(a), monthKey(a)])) : [];
  const rows = await Promise.all(
    apps.map(async (app, i) => ({
      app,
      ...(await limitsOf(app)),
      usedToday: Number(counts[2 * i] ?? 0),
      usedMonth: Number(counts[2 * i + 1] ?? 0),
      hasKey: keys.some((k) => k.name === app) || APP_API_KEYS.some((a) => a.name === app),
    }))
  );
  return { apps: rows, defaultDaily: APP_DAILY_LIMIT, resets: "daily at midnight UTC, monthly on the 1st (UTC)" };
}

// Change one app's switch or limits; fields left out keep their value.
export async function setAppLimits(app, body = {}) {
  if (!/^[a-z0-9-]{1,30}$/.test(app ?? "")) throw new AppConfigError("app: 1-30 characters, a-z 0-9 and -");
  const next = await limitsOf(app);
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") throw new AppConfigError("paused: true or false");
    next.paused = body.paused;
  }
  for (const field of ["daily", "monthly"]) {
    if (body[field] === undefined) continue;
    const n = body[field];
    if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) throw new AppConfigError(`${field}: a whole number from 0 (no limit) to ${MAX_LIMIT}`);
    next[field] = n;
  }
  next.updatedAt = new Date().toISOString();
  await redis.hSet(APP_LIMITS_KEY, app, JSON.stringify(next));
  return { app, ...next };
}
