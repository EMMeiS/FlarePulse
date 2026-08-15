# The local demo

One command fills the local database with a status page worth looking at, creates
an admin account, and starts the dev server:

```bash
npm run demo          # seed, then vite dev
npm run demo:seed     # re-seed only, e.g. between takes
```

```
Status page   /
Admin panel   /admin
Sign in       admin / flarepulse-demo-2026
```

on whichever URL Vite prints. Nothing here is deployed and nothing ships with an
account: the credential lives in `scripts/demo.mjs`, the data in
`scripts/demo-seed.sql`, and both only ever reach the local SQLite file under
`.wrangler/state`. A deployed instance still starts empty, with the one-time
create-admin screen.

## What is on screen

- **Three groups** — Core and Edge public, Internal hidden, so the status page
  shows five monitors and the admin panel shows seven.
- **Seven monitors**, one of each type: four up, one down for the last twelve
  minutes, one never checked, one disabled.
- **A day of per-minute checks** for every monitor that has been checked, plus 7
  days of hourly and 90 days of daily buckets — so the heartbeat bar, all four
  history windows and the response-time charts have real shapes rather than
  "no data yet".
- **One open incident** (opened automatically by the down monitor) and two
  resolved ones, a maintenance window in progress and another scheduled, and
  three notification channels pointing at unroutable placeholder endpoints.

Every timestamp is written relative to the moment you seed, so the page reads
"checked just now". Re-seed to reset it.

## A run of show

1. **Signed out, the public page.** The headline and the orb in the status
   colour, the maintenance banner, the groups. Expand a monitor for its
   response-time chart, then walk the 24h / 7d / 30d / 90d windows. Scroll to the
   incident timeline. Flip the theme, light to dark.
2. **`/admin`.** The login screen, then `admin` / `flarepulse-demo-2026`.
3. **Monitors.** The table with all four states in it, a row menu, a row expanded
   for its recent checks, the group list with its Public/Hidden switch, and the
   quota card's Free-plan arithmetic.
4. **Incidents.** The open automatic incident above the resolved ones, and the
   two maintenance windows.
5. **Notifications.** Three channels, one already showing a failed delivery.
6. **Settings.** The site name — changing it renames the public page's heading —
   and the two auto-incident toggles.
7. **Sign out**, which lands back on the login screen.

Making the Internal group public in step 3 is a good way to end: it appears on the
status page on the next load.

## What does not move

The cron trigger does not fire under Vite, so no check runs while you record and
the seeded picture holds still. That is usually what you want.

One tick can be forced — `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"` —
and it does exercise the realtime push, but it runs *real* checks against the
placeholder targets, which fail: a few ticks in, monitors flip down and incidents
open by themselves. `npm run demo:seed` puts the demo back.
