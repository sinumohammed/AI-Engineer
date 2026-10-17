// Phase 10d: a new key for an app that will call POST /api/ask.
//   npm run new-app-key -- crm
// Prints the key and the APP_API_KEYS entry to add (comma-separated with the
// others) in .env and on Vercel. The key is shown once; nothing is saved.
// Easier now: `npm run app -- askkey new <app>` stores it in Redis (hashed),
// working at once with no env change or deployment (askKeys.js).
import { randomBytes } from "node:crypto";

const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("Usage: npm run new-app-key -- <app-name>   (a-z, 0-9, -)");
  process.exit(1);
}
const key = `ak_${randomBytes(24).toString("base64url")}`;
console.log(`Key for "${name}" (give it to that app; it is not stored anywhere):\n\n  ${key}\n`);
console.log(`Add to APP_API_KEYS:\n\n  ${name}=${key}\n`);
console.log("(Or skip the env var and deployment: npm run app -- askkey new " + name + ")");
