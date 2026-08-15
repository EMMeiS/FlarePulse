#!/usr/bin/env node
/**
 * Seeds the local development database with demo data and an admin account, so
 * that logging in, the public status page and the admin panel can all be shown
 * — or recorded — without a deploy. `npm run demo` runs this and then Vite.
 *
 * Local only, in two senses. Every write goes through `wrangler --local`, which
 * touches the SQLite file under `.wrangler/state` and never the remote database;
 * and the password below exists only in this file. Nothing ships with an
 * account: a deployed instance still shows the one-time create-admin screen,
 * and this script is what stands in for that screen here.
 *
 * The hash is produced by the Worker's own `hashPassword`, so the row this
 * writes is indistinguishable from one the setup screen would have written.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "../src/auth.ts";

const USERNAME = "admin";
/** Fifteen characters: over MIN_PASSWORD_LENGTH, and quick to type on camera. */
const PASSWORD = "flarepulse-demo-2026";

const root = join(import.meta.dirname, "..");

function wrangler(...args) {
  execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], {
    cwd: root,
    stdio: "inherit",
    // Wrangler asks before applying migrations when it thinks someone is
    // watching. Here the answer is always yes.
    env: { ...process.env, CI: "true" },
  });
}

const password_hash = await hashPassword(PASSWORD);

// `verifyPassword` reaches for `timingSafeEqual`, a workerd extension to
// SubtleCrypto that node does not have. Filling it in is what lets the app's own
// verification run here, and a hash that does not verify is a login that would
// have failed on camera.
crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
if (!(await verifyPassword(PASSWORD, password_hash))) {
  throw new Error("the seeded hash does not verify against its own password");
}

wrangler("d1", "migrations", "apply", "DB", "--local");
wrangler("d1", "execute", "DB", "--local", "--file", "scripts/demo-seed.sql");
wrangler(
  "d1",
  "execute",
  "DB",
  "--local",
  "--command",
  `DELETE FROM admins;
   INSERT INTO admins (id, username, password_hash) VALUES (1, '${USERNAME}', '${password_hash}');`,
);

console.log(`
FlarePulse demo data is in the local database.

  Status page   /
  Admin panel   /admin
  Sign in       ${USERNAME} / ${PASSWORD}

on whichever URL Vite prints below. Nothing moves while you record: the cron
trigger does not fire under Vite, so no check overwrites the seeded picture.

Every timestamp is written relative to now, so the page reads "checked just
now" — run \`npm run demo:seed\` again between takes to reset it.

Local only. This is the SQLite file under .wrangler/state; the remote database
is untouched, and a deployed instance has no account until someone creates one
on the setup screen.
`);
