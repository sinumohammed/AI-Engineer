// Phase 10 #4: who is asking - so a connected app's data reaches only the
// callers it names (appRegistry.js, `callers`), and the app can answer as the
// logged-in user would see it (`user`).
//
//   { caller: "web" }                              the web chat (server.js)
//   { caller: "masjid", userToken: "..." }         POST /api/ask with the masjid app's key,
//                                                  for one of its logged-in users (askApi.js)
//   display: { tables, charts }                    what the asking app's screen can show (display.js)
//
// Kept per request with AsyncLocalStorage instead of being passed through
// every agent, router and specialist function: set once where a request
// arrives, read where apps are listed and called (apps.js). Code that runs
// outside a request (the regression evals) has no caller, so no apps - this
// service stays generic unless an app is asked for by name.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export function withAccess(access, fn) {
  return store.run({ caller: access.caller ?? null, userToken: access.userToken ?? null, admin: Boolean(access.admin), display: access.display ?? null }, fn);
}

export function currentAccess() {
  return store.getStore() ?? { caller: null, userToken: null, admin: false, display: null };
}

// May this request use this app? The admin's "try" may use any app, but an
// app that needs a user still needs one.
export function callerMayUse(app, access = currentAccess()) {
  if (!access.admin && !(app.callers ?? []).includes(access.caller)) return false;
  if (app.user === "required" && !access.userToken) return false;
  return true;
}
