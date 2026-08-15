/**
 * First-deploy provisioning, and the one command a routine deploy can use too.
 *
 *   npm run setup [-- --location weur]
 *
 * It creates the D1 database if it does not exist yet, writes the real
 * `database_id` into wrangler.jsonc, then hands over to `npm run deploy`, which
 * applies the migrations and uploads. Every step is idempotent, so re-running it
 * after a code change is a valid release: an existing database is reused,
 * applied migrations are skipped, and the deploy uploads a new version.
 *
 * What it deliberately does not do is log you in. `wrangler login` is an
 * interactive browser flow and it has to be the operator's own hands.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wrangler on Windows is a `.cmd` shim, which `execFile` will not run without a shell. */
const wrangler = (args, capture = false) =>
  execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    shell: true,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const config = readFileSync(CONFIG, "utf8");
// The config is JSONC, so it is read with a pattern rather than JSON.parse: the
// comments in it are the documentation for the bindings and worth keeping.
const name = config.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1];
const current = config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
if (!name || current === undefined) fail("wrangler.jsonc has no D1 binding to set up.");

try {
  wrangler(["whoami"]);
} catch {
  fail("Not logged in. Run `npx wrangler login` first, then run this again.");
}

let id = UUID.test(current) ? current : null;
if (id) {
  console.log(`\n→ wrangler.jsonc already points at ${name} (${id}). Reusing it.`);
} else {
  const location = process.argv.indexOf("--location");
  const databases = JSON.parse(wrangler(["d1", "list", "--json"], true) || "[]");
  id = databases.find((database) => database.name === name)?.uuid ?? null;

  if (id) {
    console.log(`\n→ ${name} already exists in this account. Reusing it.`);
  } else {
    console.log(`\n→ Creating the D1 database ${name}.`);
    wrangler(["d1", "create", name, ...(location > -1 ? ["--location", process.argv[location + 1]] : [])]);
    const created = JSON.parse(wrangler(["d1", "list", "--json"], true) || "[]");
    id = created.find((database) => database.name === name)?.uuid ?? null;
    if (!id) fail(`Created ${name} but could not read its id back from \`wrangler d1 list\`.`);
  }

  writeFileSync(CONFIG, config.replace(/("database_id"\s*:\s*")[^"]*"/, `$1${id}"`));
  console.log(`→ Wrote database_id ${id} into wrangler.jsonc.`);
}

console.log("\n→ Migrating and deploying.");
execFileSync("npm", ["run", "deploy"], { shell: true, stdio: "inherit" });

console.log(`
✓ Deployed.

  Claim the admin account now, before anything else: open /admin on the URL
  above and create it. Until you do, the one-time setup screen is open to
  whoever finds the URL. There are no default credentials to fall back on.
`);
