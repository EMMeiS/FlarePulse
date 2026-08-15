# Deploying FlarePulse

FlarePulse is one Worker: the API, the React client, the cron checker and the Durable Object ship in a single `wrangler deploy`. There is nothing else to provision — no VM, no managed database, no second host for the frontend.

This runbook goes from a clean checkout to a live, claimed, monitored instance. Run the steps in order; the order of steps 7 and 8 in particular is a security property, not a preference.

## What you need

- A Cloudflare account on the **Free** plan. Nothing here requires Paid.
- Node 20+ and this checkout.
- **No secrets.** FlarePulse needs no `wrangler secret` and no `.dev.vars` in production: notification credentials — a Discord webhook URL, a Telegram bot token and chat id — are per-channel rows in D1 that you enter through the admin UI after the deploy. Do not put them in the repository.

## The short path

Two ways to get a live instance without reading the rest of this file.

**The button.** [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/EMMeiS/FlarePulse) clones the repository into your own GitHub or GitLab account, provisions the D1 database and the Durable Object, rewrites the generated ids in `wrangler.jsonc`, and runs the `deploy` script. The button does **not** apply D1 migrations itself, which is why `deploy` chains `db:migrate` ahead of the upload — the schema is in place on the first version because of that, not by luck.

**One command**, from a clone:

```bash
npm install
npx wrangler login
npm run setup
```

`npm run setup` creates the `flarepulse` database if the account does not have one, writes its real id into `wrangler.jsonc`, then hands over to `npm run deploy`. Add `-- --location weur` to pick a D1 location hint. Every step is idempotent, so re-running it after a code change is a valid release: an existing database is reused, applied migrations are skipped, and the deploy uploads a new version.

Either way, **go straight to step 7 and claim the admin account.** Steps 1 to 6 below are the same work done by hand, for when something needs inspecting; steps 7 to 11 matter regardless of how you deployed.

## 1. Install

```bash
npm install
```

## 2. Log in

The login is an interactive browser flow, so it has to be you:

```bash
npx wrangler login
npx wrangler whoami
```

`whoami` should print the account you intend to deploy into. If you have more than one, note the account id — `wrangler` will ask which to use, or you can set `CLOUDFLARE_ACCOUNT_ID`.

## 3. Create the remote database

```bash
npx wrangler d1 create flarepulse
```

The command prints a configuration block containing the real `database_id`. Put that id into `wrangler.jsonc`, replacing the `"REPLACE_WITH_YOUR_DATABASE_ID"` placeholder:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "flarepulse", "database_id": "<the id it printed>", "migrations_dir": "migrations" }
]
```

`npm run setup` does exactly this much and then continues; the manual version exists for when you want to see the id before it lands in the file. The placeholder itself is only ever read by a deploy — local dev and the test pool ignore it — so a deploy with it still in place fails to bind D1.

## 4. Apply the migrations

```bash
npm run db:migrate
```

That is `wrangler d1 migrations apply DB --remote`. It names the **binding**, not the database, so it keeps working if the database is called something else — which is what the deploy button produces. Expect five migrations, `0001_init` through `0005_rename_to_flarepulse`, and `--remote` is what makes this the real database rather than the local one under `.wrangler/`. Re-running it later is safe: applied migrations are skipped.


## 5. Dry run

```bash
npx wrangler deploy --dry-run
```

This builds and validates without uploading anything. It should read the assets directory and resolve three bindings: `MONITOR_HUB` (Durable Object), `DB` (D1) and `ASSETS`.

## 6. Deploy

```bash
npm run deploy
```

That is `npm run db:migrate && vite build && wrangler deploy`: the migrations land first, then the client builds into `dist/client` and the Worker into `dist/flarepulse`, and both upload as one version. The first deploy also registers the Durable Object migration (`tag: "v1"`, `new_sqlite_classes: ["MonitorHub"]`) and the cron trigger (`* * * * *`).

Wrangler prints the URL, `https://flarepulse.<your-subdomain>.workers.dev`. Open it: with no monitors yet the hero reads "Waiting for the first checks" over "0 of 0 monitors operational", which is the honest empty state rather than a green all-clear.

## 7. Claim the admin — do this immediately

FlarePulse ships **no default credentials**. The first visit to `/admin` shows a one-time setup screen that creates the only admin account, and that screen closes permanently once an admin row exists.

Until you complete it, anyone who finds the URL can claim your instance. So do it now, before adding monitors, before configuring anything else:

1. Open `https://flarepulse.<your-subdomain>.workers.dev/admin`.
2. Create the admin username and password.
3. Reload `/admin` and confirm you now get the sign-in form, not the setup form.

There is one admin per instance by design. There is no password reset by email — there is no mail binding and no second account to authorise one. The documented recovery path is step "Locked out" below.

## 8. Verify it actually runs

- `curl https://flarepulse.<subdomain>.workers.dev/api/health` returns `{"ok":true,"name":"FlarePulse"}`.
- Add one HTTP monitor through the admin panel. It starts `pending`, and within two minutes the cron tick should move it to `up` with a latency figure and a first heartbeat.
- `npx wrangler tail flarepulse` shows one `scheduled` invocation per minute. This is the single best signal that the checker is alive.
- The admin quota card estimates writes per day from your monitors and intervals; the Cloudflare dashboard is the authority on actual usage, and the card says so. Compare them once here.

## 9. Send one real notification

Every delivery in the test suite is a spy, so nothing has yet reached a real Discord or Telegram. Send one for real, once:

1. Add the channel in the admin panel (Discord webhook URL, or Telegram bot token plus chat id).
2. Use the channel's test send, or point a throwaway monitor at a URL you can break, and watch the message arrive.
3. Check the channel row's last-delivery status afterwards — a failed send is recorded there rather than thrown away.

A Telegram bot token is a credential. It is stored in D1 and read only by the Worker; it never appears in the public status payload.

## 10. Verify the TCP probe against the edge

A TCP monitor reports "the handshake completed" and nothing more, and its accuracy depends on one constant — `TCP_GRACE_MS` in `src/checks.ts`, currently 2,500 ms. Silence past that window counts as up; an error before it counts as down.

That constant could not be measured locally: in workerd, a connection to a host that does not resolve, and to a closed remote port, both stay silent for more than 8 seconds without an error, so a laptop cannot tell up from down. The edge is the only place this is answerable, so measure it once here:

1. Add a TCP monitor for a port you know is open (`example.com:443`).
2. Add one for a port you know is closed on a host that resolves.
3. Wait two ticks and compare. The open port must be up. **If the closed port also reports up, raise `TCP_GRACE_MS`** until it does not, and redeploy. Latency figures are unaffected — they are taken at the handshake, before the grace window.

Delete both probes afterwards. Note also what the platform refuses on every plan, Free or Paid: port 25, Cloudflare's own IP ranges, `localhost` and private ranges, and a Worker connecting back to itself.

## 11. Optional: a custom domain, and the only way to rate limit

`/api/live` is an unauthenticated WebSocket endpoint by design — everything it carries is already on the public page — and its only protection in code is a cap of 256 concurrent sockets, past which the upgrade is refused with a 503 and the page degrades to render-and-don't-move.

A WAF rate limiting rule in front of it needs a **zone**, which means a custom domain. A `workers.dev` subdomain is Cloudflare's zone, not yours, so there is no WAF, no rate limiting rule and no firewall rule to configure for it. If you want one:

1. Add your domain to Cloudflare, then add it to this Worker as a custom domain (Workers → your Worker → Settings → Domains & Routes).
2. Create the one rate limiting rule the Free plan includes: Security → WAF → Rate limiting rules. Free-tier rules can match on **path** only, count by **IP** only, and the period and mitigation timeout are both fixed at 10 seconds. `/api/live` as the path expression is exactly the shape that fits.

Without a custom domain, the socket cap is the whole story. That is an acceptable answer for a hobby instance and a deliberate one — it is written down in `docs/DECISIONS.md` rather than papered over.

## Routine updates

```bash
npm run typecheck && npx vitest run && npm run build   # the full gate, offline
npm run deploy                                         # migrates, builds, uploads
```

`deploy` runs the migrations before it builds, so new code never reaches the edge ahead of the column it reads. The same gate runs in GitHub Actions on every push and pull request, so a red run is visible before you deploy rather than after.

## When it goes wrong

- **A bad deploy.** `npx wrangler rollback` returns to the previous version; `npx wrangler rollback <version-id>` targets a specific one, and `npx wrangler deployments list` shows the ids. A rollback does not undo a migration — the schema is append-only for exactly this reason.
- **Locked out of the admin.** Five failed sign-ins lock the account for 15 minutes; wait it out rather than assuming the password is wrong. If it really is lost, there is no email reset — delete the admin row and the one-time setup screen reopens: `npx wrangler d1 execute DB --remote --command "DELETE FROM admins"`, then visit `/admin` and create it again. Sessions reference the admin with `ON DELETE CASCADE`, so every existing session goes with it.
- **Every dashboard reconnects after a deploy.** A deploy restarts every Durable Object and drops every WebSocket. The client reconnects with backoff and refetches rather than replaying, so a brief "Offline" badge after each deploy is expected behaviour, not a fault.
- **Checks stop moving.** `npx wrangler tail flarepulse` first: no `scheduled` line every minute means the cron trigger is the problem, not the checker. Confirm the trigger under Workers → your Worker → Settings → Trigger Events.
- **The quota card looks alarming.** It is arithmetic over your intervals, not a measurement. 20 monitors at 60 s is roughly 28,800 heartbeat writes a day against the Free plan's 100,000 row writes; lengthening intervals is the lever.

## What this deploy does not include

CI runs the gate — typecheck, tests, build — on every push and pull request, and stops there: no deploy step, no environment secret in the repository, no staging environment, no gradual version rollouts, no Logpush or Analytics Engine. Releases stay a deliberate `npm run deploy` from the operator's own machine, which is the right size for a single-operator instance.


