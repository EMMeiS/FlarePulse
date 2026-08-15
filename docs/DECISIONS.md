# Decisions

Newest entries at the bottom. Each entry records what was decided and, where it matters, why.

---

## 1 — v1 design decisions

The shape v1 committed to, and the arithmetic behind it.

### Product shape

- **Self-hostable, single-admin.** One admin per instance, a public read-only status page, no multi-user, no RBAC, no billing.
- **Display name is "Levix"** — the panel name, the way "Uptime Kuma" names the panel rather than a domain. Logo is a Reicon activity/pulse glyph in the accent colour with a "Levix" wordmark until a real logo exists. Uptime Kuma's own artwork is not used; it is their trademark.
- **Monitor types**: HTTP(s) first and complete, then TCP port and DNS alongside it. No ICMP ping, because Workers cannot send raw ICMP — the UI states this rather than faking a ping type.
- **Per-monitor settings**: interval, retries before flipping to DOWN (default 2), timeout. **Global settings**: auto-open incident on down, auto-resolve on recovery.
- **Status page**: monitor groups each with a public/private flag, an embeddable badge, and 24h/7d/30d/90d chart windows.
- **Themes**: light and dark, system preference by default, one toggle.
- **Notifications v1**: generic webhook, Discord, Telegram. Slack dropped — Telegram and Discord are the two that matter and a third webhook variant adds nothing. Resend/email deferred: it needs its own account plus domain verification.
- **Liquid glass is an accent, not a theme.** Status page hero and the overall-status card only, with `contain: strict`, an `@supports` opaque fallback, an `isolation: isolate` text layer, and `prefers-reduced-motion` respected.
- **Free-plan quota headroom is shown in the admin UI** so whoever runs the instance can see how close they are to the D1 row-write and request ceilings.

### Two answers that were corrected on factual grounds

- **No shipped default credentials.** The first idea was a known first-login username and password, changed after the first sign-in. Rejected: this panel gets published on a `workers.dev` URL, and published panels with documented default credentials get scanned within days. Instead the first visit shows a one-time create-admin screen — Uptime Kuma's model — which closes permanently once an admin row exists.
- **60 seconds is the interval floor, not 30.** Cron triggers cannot fire more often than once a minute. Sub-minute checks would need Durable Object alarms, and presenting a 30s setting that actually resolves to 60s would break the "say what's true" rule. The floor is stated plainly in the UI.

### Scale target and the arithmetic behind it

- Target is **under 20 monitors**, checks run inline in the cron handler — no Queues fan-out until it is actually needed.
- The ceilings that set that: one heartbeat row per check at 60s is 1,440 rows/day/monitor against D1 Free's 100k rows written/day, so roughly 60 monitors maximum on storage alone; 10 ms CPU and 50 external subrequests per invocation cap a single cron tick at roughly 40 HTTP checks. Twenty monitors leaves real headroom on both.
- **Retention**: raw heartbeats 7 days, hourly rollups 90 days, daily rollups 2 years, pruned during the hourly rollup pass.

### Process

- **Free plan, an existing Cloudflare account, domains already on Cloudflare DNS.** Deploy to `<worker>.<subdomain>.workers.dev` for v1; a custom domain is optional later, and the public base URL lives in exactly one config value.
- **No `wrangler login` until the deploy is due.** Everything before that is local: Vitest runs in workerd, `wrangler dev` runs offline.
- **Testing**: strict TDD for backend logic and API handlers against real D1 and Durable Object bindings; UI gets render and smoke tests only.
- **Git**: single `main` branch, one commit per green gate, no worktrees.

### Open, to be settled empirically

- **Does the Workers TCP `connect()` API work on the Free plan?** The docs do not say. The checker opens one real connection and, if it turns out to be Paid-only, disables the TCP monitor type with an honest message instead of failing silently. Port 25 and Cloudflare's own IP ranges are blocked on every plan regardless.

---

## 2 — The scaffold, and what building it settled

- **The Cloudflare Vite plugin owns the assets config.** One `vite build` emits the client to `dist/client` and the Worker to `dist/levix`, and generates `dist/levix/wrangler.json` with the assets wiring already filled in. So `wrangler.jsonc` declares `assets` **without** a `directory` key — setting one by hand would fight the plugin. Checked against the real build output rather than assumed.
- **A Durable Object export and a `scheduled()` handler coexist with the plugin.** The Worker bundle builds with both present, so the pre-plugin fallback (plain `vite build` plus a hand-written `assets` binding) is not needed. Runtime behaviour of `scheduled()` and of the Durable Object comes later; the scaffold only proves they build and that the bindings exist on `env`.
- **`@cloudflare/vitest-pool-workers@0.21.3` really is plugin-shaped.** `cloudflareTest({ wrangler: { configPath } })` in `vitest.config.ts`, `env` imported from `cloudflare:workers`, `createExecutionContext`/`waitOnExecutionContext` from `cloudflare:test`. The `defineWorkersConfig`/`poolOptions.workers` form that most tutorials still show is gone; so are `isolatedStorage` (isolation is automatic per test file) and `fetchMock` (use `vi.spyOn(globalThis, "fetch")`).
- **TypeScript 7 removed `baseUrl`.** `tsc` fails with TS5102 if it is present. Path mapping now lives in `paths` alone, resolved relative to the config file.
- **The Vite alias is root-relative (`"@": "/frontend"`)** instead of `fileURLToPath(new URL(...))`, which keeps `@types/node` out of the dependency tree for the sake of one line in `vite.config.ts`.
- **npm 11 gates install scripts.** `esbuild` and `workerd` need `npm install-scripts approve esbuild workerd` after a fresh `npm install`, otherwise their platform binaries are never linked. Worth knowing before blaming Wrangler for a missing runtime.
- **shadcn/ui was initialised without the interactive `init`.** `components.json` is hand-written — `tailwind.config: ""` is correct for Tailwind v4, and the ReUI registry is declared as `"@reui": "https://reui.io/r/base-nova/{name}.json"` with the style hardcoded, because `{style}` would resolve to shadcn's `new-york` and miss ReUI's registry entirely. Verified by having the CLI actually install `button`.
- **Reicon's API is a flat named export per icon** (`import { Activity } from "reicon-react"`), with `reicon-react/icons/<Name>` available for narrower imports.
- **Deliberately deferred**: the real D1 `database_id` (it needs a login — `"levix-local"` is a placeholder that local dev and the test pool never read), migrations and schema, actual use of the D1 and Durable Object bindings, ReUI blocks, and the transitions.dev recipes, which get copied in when there is motion to wire and not before.

---

## 3 — The data layer

- **The schema covers monitors, groups, heartbeats and the two rollup tables — nothing else.** Incidents, notification channels, maintenance windows, status page config and admin users each arrive as their own `000N_*.sql` when the screens that need them exist. Migrations are append-only files, so early guessing buys nothing and locking the schema in ahead of the UI is how you end up with columns nothing reads. The rollup tables are the one exception, created empty because the retention plan is already settled (#1).
- **The 60s floor is a `CHECK (interval_seconds >= 60)` constraint**, not a UI rule. Any future API or import path gets the same answer, and the test asserts on the constraint error text so it cannot pass for the wrong reason.
- **`src/db.ts` holds no business logic.** `recordCheck` persists a status, a fail streak and a next-check time that the *caller* decided; it has no clock of its own and no retry rule. The "flip to down after N consecutive failures" decision stays in the checker as a pure function, where it can be unit-tested without a database.
- **`recordCheck` writes the heartbeat and the monitor update in one `db.batch()`** — one D1 subrequest instead of two, per monitor, per minute. At the Free plan's per-invocation subrequest limits that is the difference between comfortable and tight.
- **The cron query has its own index** (`monitors_due` on `(enabled, next_check_at)`) because it runs every 60 seconds for the life of the deployment.
- **`MonitorHub` is RPC-shaped, not `fetch`-shaped.** `setStatus`/`snapshot` as plain methods on the class; state lives in the object's own SQLite storage. Verified to survive `evictDurableObject`, which is the property that matters — an in-memory map would have passed the other two tests and failed in production.
- **`readD1Migrations` is exported from the package root**, not the `@cloudflare/vitest-pool-workers/config` subpath its own doc comment mentions. Migrations are read in Node inside `vitest.config.ts`, passed to the pool as a `TEST_MIGRATIONS` miniflare binding, and applied in a `setupFiles` `beforeAll`. Per-file storage isolation makes that a clean database for every test file. The binding is typed in `tests/env.d.ts` only, so Worker code cannot reach for it.
- **`ctx.storage.sql.exec<T>()` requires its row type to carry an index signature** (`interface StatusRow extends Record<string, SqlStorageValue>`), otherwise TS2344.
- **`wrangler d1 migrations apply levix --local` works offline** with the placeholder `database_id`, writing to `.wrangler/state`, so `vite dev` has real tables without a Cloudflare login.

---

## 4 — Prior art, and the design references

What this borrows from, and what each reference is actually for.

### Prior art — what to borrow, what to skip

| Project | Worth stealing | Leave behind |
|---|---|---|
| **Uptime Kuma** | Reactive live dashboard, heartbeat-bar visualisation, breadth of monitor types | Its Node/SQLite single-server model — there is no persistent server here |
| **Upptime** | "No infrastructure to maintain", incident-as-a-timeline | GitHub Actions/Issues as the backend — Workers gives real compute and storage |
| **Cachet** | Component/group status model, card-based dashboard, incident update timeline | PHP/Laravel. Its v3 rebuild (Laravel + Tailwind + Filament) is the more relevant design reference than the old v2 UI |
| **cState** | Config-as-code simplicity, no bloat | "Static site, you feed it results externally" — Levix has its own active checker |

### The five design references

- **[reicon.dev](https://reicon.dev/)** — MIT SVG icon set, 2,700+ icons in outline/filled/duotone. The single icon source for the whole app; no mixing icon libraries. Installed as `reicon-react`.
- **[transitions.dev](https://transitions.dev/)** — accessible copy-paste CSS/React micro-interactions that respect `prefers-reduced-motion` by default. Pull transitions by name (status badge change, incident timeline reveal, monitor card state change) instead of hand-rolling keyframes.
- **[ui.shadcn.com](https://ui.shadcn.com/docs)** — the Radix + Tailwind primitives everything else builds on, copied into the repo rather than imported.
- **[reui.io/components](https://reui.io/components)** — composed shadcn-based blocks (data grid, charts, timeline, filters) for the admin dashboard's heavier pieces. Registry wired in `components.json` as `"@reui": "https://reui.io/r/base-nova/{name}.json"`.
- **[freefrontend.com/css-liquid-glass](https://freefrontend.com/css-liquid-glass/)** — `backdrop-filter` + `feDisplacementMap` glassmorphism. Used on the status page hero and overall-status card only, never globally, because it is GPU-expensive (`contain: strict`, small footprint), it wrecks text legibility (text on its own `isolation: isolate` layer with real contrast), and it needs a flat `@supports` fallback plus `prefers-reduced-motion`.

---

## 5 — The checker engine

- **`retries` means extra attempts, so the default of 2 flips a monitor down on the third consecutive failure.** `nextState(monitor, status, checkedAt)` is a pure function — no clock, no bindings — and takes the raw check status rather than the whole outcome, because latency and message are the heartbeat's business. Inside the retry window the monitor keeps its previous status while each failure is already a red heartbeat, which is Uptime Kuma's `PENDING` idea without adding a fourth status the UI would have to explain. `pending` keeps meaning "never checked".
- **No `degraded` state and no shortened retry interval.** Both would be new promises made before there is a UI to explain them. One interval per monitor is what the 60s cron floor supports.
- **Probes never throw.** Every check returns a `down` outcome carrying the failure message — a bad target, a rejected fetch, a refused socket. One broken monitor row cannot take down the tick that checks the other nineteen.
- **`socket.opened` resolving is not proof of a TCP connection.** The runtime dials lazily, so `checkTcp` reads once after opening: a rejected read is `down`, silence past a 250 ms grace window is `up` (most services speak second). Verified by probe against a closed local port, an unresolvable host and a real host.
- **The TCP Free/Paid question from entry 1 is still open, and now for a documented reason.** The probe confirms `connect()` compiles and runs under workerd and that a refused *local* port reports down, but local workerd does not surface remote socket failures: an unresolvable hostname and a closed remote port both came back up. Nothing local can answer it, so the deployed Worker re-probes before the TCP type is presented as trustworthy in the UI (#10).
- **DNS checks go through Cloudflare's JSON DoH endpoint** (`cloudflare-dns.com/dns-query`, `accept: application/dns-json`), because Workers cannot send raw UDP. Target syntax is `hostname` or `hostname/TYPE`, defaulting to `A`. `Status !== 0` or an empty `Answer` is `down`.
- **HTTP checks only read the response body when a `keyword` is configured.** Reading it otherwise spends CPU from a 10 ms budget on nothing, and there is a test asserting the body is not touched.
- **Probes run concurrently in one tick, persistence stays one batch per monitor.** Serial probing of 20 monitors at a 10 s timeout would outlast the minute it has to fit in; concurrency does not change the subrequest count, which stays well under the Free plan's 50 external per invocation.
- **The rollup pass runs on the first tick of each hour** (`now % 3600 < 60`, because cron fires near the minute rather than on it) and looks back six hours, so a missed tick is made up without reading a week of raw rows every hour. Longer gaps leave a hole in the hourly history rather than a recurring 200k-row read.
- **Daily buckets are rolled once at midnight from raw heartbeats, not from the hourly rows.** Raw rows outlive by days the day they describe, so this gives a real p95 instead of an average of averages. Percentiles are computed in JS by nearest rank — D1's SQLite has no percentile function.
- **Rollup and prune are idempotent**: every write is an `ON CONFLICT DO UPDATE` upsert and every delete is horizon-based, so a retried tick changes nothing.
- **`createScheduledController` from `cloudflare:test` plus a direct `worker.scheduled(...)` call is how the cron handler is tested** — same shape as the existing `worker.fetch` tests, no `SELF` needed. `waitOnExecutionContext` still applies.
- **The one injected dependency here is `connect`**, as an argument default on `checkTcp`, so the suite drives a fake socket and stays offline. Everything else is exercised through `vi.spyOn(globalThis, "fetch")` against real D1 and a real `MonitorHub`.

---

## 6 — The public status page

### Two constraints that shaped it

- **No charting dependency.** The chart and the badge are hand-written SVG — about 90 lines against a library, its bundle and its own opinions about axes — and the page is built from what the project already carries: React 19, Tailwind v4, `reicon-react`, the one `button.tsx` and `cn()`. Worth revisiting when a second chart shape shows up, not before.
- **`renderToString` from `react-dom/server` runs inside the `vitest-pool-workers` pool**, and the pool transforms `.tsx`. That is the whole UI test strategy — no jsdom, no Testing Library, no new dependency, one suite. Components take props and never fetch, which is what makes it work and is the right shape anyway.
- **Import Reicon icons by subpath** (`reicon-react/icons/Activity`), never from the package root. The root barrel re-exports 5,348 icons: importing it made a single UI test file take 80 seconds to transform. Subpath imports brought the whole suite back to under 4 seconds.

### The read path

- **Five D1 queries per page load, not four.** `publicMonitors` first (its result decides the ids the rest bind), then `uptimeSince`, `heartbeatBars`, `activeMaintenance` and `recentIncidents` in one `Promise.all`. Four with the last two in a `db.batch` was the first sketch; `Promise.all` of independent reads is the same round trips without pretending the two tables are one write. What matters held: every query is flat in the monitor count. A per-monitor loop would be 21 queries at twenty monitors.
- **One window, one source, never a blend.** `24h` reads raw `heartbeats` and buckets them hourly in JS; `7d` reads `heartbeat_hourly`; `30d` and `90d` read `heartbeat_daily`. A chart whose left half means something different from its right half is worse than one that stops at the last closed bucket. Percentiles agree across sources because `percentile` and `bucketHeartbeats` were extracted from the rollup pass and are now shared by the writer and the reader.
- **An unknown `window` value resolves to `24h`** rather than 400. A status page's job is to render.
- **Ungrouped monitors are public.** `monitor_groups.is_public = 0` is the mechanism for hiding a monitor, and defaulting a fresh install to a blank status page would be the worse surprise. The monitor form has to say this out loud.
- **Targets never leave the Worker.** `PublicMonitorRow` selects `id, name, type, status, last_checked_at, group_id, group_name` and nothing else; a test asserts the serialised payload contains neither the seeded target nor the private group's name.
- **A disabled monitor is not published at all** — it is not being checked, so its last known status would be a claim we cannot make.
- **The per-monitor series is fetched on demand**, when a visitor expands a card, and cached in component state. No N+1 on load.
- **The page does not poll.** `cache-control: public, max-age=30` on `/api/status`, 60s on the series, and the realtime layer replaces the gap with a WebSocket push rather than a timer (#9).

### The badge

- **`GET /api/badge/:file{[0-9]+\.svg}`** — the extension is part of the parameter so the URL ends in `.svg`, which is what a README image tag needs, and a non-numeric id simply fails to match and falls to the 404 handler.
- It shows the name, the **24h uptime** and the current status colour, says `no data` when a monitor has no heartbeats yet, XML-escapes both texts, and carries `role="img"` plus a `<title>` so a screen reader gets "api: 99.95% (up)" instead of silence.
- **Width is estimated at 6.5px per character.** Marked in the code as the known ceiling: a Worker has no font tables, and a real text-metrics table is what a font-accurate badge would need.

### The page itself

- **`frontend/App.tsx` was deleted, not modified.** `main.tsx` renders `StatusPage` directly — the scaffold's health-check card had no reason to outlive the scaffold.
- **Four status tokens became five.** `--up`, `--down`, `--pending`, `--maintenance` plus `--degraded`, because a chart bucket at 50% uptime is neither up nor down and painting it green would hide the dip the chart exists to show. All five are exposed through `@theme inline`, so a colour change is one file. Maintenance is blue rather than amber: planned work is not a problem, and reusing the warning colour would say it was.
- **`aria-pressed`, not `aria-current`, on the window switcher.** They are buttons that change a view, not links marking a location.
- **Status is never colour-only**: every card carries its status as text, every bar row is a labelled `role="img"`, the expand control is a real `<button>` with `aria-expanded`/`aria-controls`, and the theme toggle is labelled.
- **Text is assembled with template literals rather than adjacent JSX expressions.** React emits `<!-- -->` markers between sibling expressions, which bloats the HTML and splits strings a reader — or a test — expects to be one sentence.
- **The latency chart draws one path per contiguous run of samples.** A bucket with no successful check has no latency, and drawing straight through it would invent a measurement. `preserveAspectRatio="none"` stretches the chart to its container and `vector-effect="non-scaling-stroke"` keeps the strokes from stretching with it.
- **`contain: layout paint style`, not `contain: strict`, on the glass card.** #1 said `strict`; `strict` includes size containment, which collapses a content-sized card to nothing. Everything else from #1 is present: the opaque card is the base and the translucent `backdrop-filter` is inside `@supports`, the content sits on its own `isolation: isolate` layer, a `prefers-reduced-motion: reduce` block neutralises every transition, and there is no `feDisplacementMap` anywhere — the SVG-filter half of "liquid glass" is the expensive half.
- **The theme is applied by an inline script in `index.html` before first paint**, so a dark-mode visitor never sees a white flash; the toggle owns the rest and persists to `localStorage` under `levix-theme`. The key is duplicated in exactly two places and both name the other.
- **The footer states the three limitations** — one Cloudflare-selected vantage point, the 60 second floor, no ICMP — on every render, including the loading and error states.

### Test-harness changes

- `vitest.config.ts` gained `resolve: { alias: { "@": "/frontend" } }` so the render tests import components the way the components import each other.
- `tests/tsconfig.json` now includes `**/*.tsx` but deliberately **not** `../frontend`: that project overrides `types` with the workers pool types, which drops `vite/client` and with it the `*.css` module declaration `main.tsx` needs. The root project typechecks the frontend; the tests project typechecks the tests.
- **"Renders" here means `renderToString` produces the right markup**, plus `vite build` compiles it. Layout, blur and motion are a browser's verdict, and every later entry that touches the UI says the same thing.

---

## 7 — The admin panel and built-in auth

Migration `0003_admin_sessions_settings.sql`.

### The password, and the 10 ms ceiling that set it

- **PBKDF2-SHA256 is not a choice.** workerd exposes no scrypt, argon2 or bcrypt, and a Worker cannot load a native module. `src/auth.ts` says so at the top so the next reader does not go looking.
- **15,000 iterations, measured, not copied.** In workerd, PBKDF2-SHA256 costs ~4 ms at 10k, ~6 ms at 15k, 33 ms at 100k and 201 ms at the OWASP-2023 figure of 600k. The Workers Free plan allows 10 ms of CPU per invocation, so a login route at 600k would be killed before it answered. This is an order of magnitude below current guidance and is written down as such: the compensating controls are the 12-character minimum, the five-strike lockout, and the fact that reading the hash at all means already holding the Cloudflare account.
- **The parameters live inside the hash** (`pbkdf2-sha256$<iterations>$<salt>$<hash>`), so the upgrade path on a Paid plan is one constant and one password change — old and new hashes both keep verifying.
- **An unparseable stored hash is a failed login, not a 500.** The caller's answer is the same either way, and a 500 on a corrupt row tells an attacker more than a 401 does.
- **Comparison is `crypto.subtle.timingSafeEqual`**, not `===` on base64.

### Sessions, and the one-admin constraint

- **The session row's id is the SHA-256 of the cookie value; the token itself is never stored.** A database dump must not hand over live sessions. Logout deletes the row, so revocation is server-side and not just a cleared cookie.
- **Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`.** Seven days, because a monitoring panel is a daily habit rather than a session per action. The hourly cron pass prunes expired rows via `sessions_expiry`.
- **`SameSite=Strict` plus a JSON-only mutation surface is the whole CSRF answer.** No token table, no double-submit cookie: a cross-site form post cannot send `content-type: application/json`, and a strict cookie is not attached to the request anyway.
- **One admin is enforced by `CHECK (id = 1)`** rather than by a handler that a second code path could forget. `POST /setup` is 409 forever once the row exists, which is what permanently closes the create-admin screen (#1). The day someone wants a second account is the day to write the migration.
- **Five failures buy fifteen minutes** (`lockState`, pure and unit-tested). On a single-admin instance that is also a self-DoS — anyone who can reach the login form can keep the owner locked out. Accepted: it makes online guessing pointless, Cloudflare's own rate limiting is the tier above it, and the documented recovery path is `wrangler d1 execute` against the instance. There is no password reset by email: there is no mail binding and no second account to authorise one.
- **Route order is the auth boundary.** `app.route("/api/admin", adminAuth)` is registered before `app.route("/api/admin", adminApi)`, and Hono's first-match-wins means the session gate never sees session/setup/login/logout. Every other `/api/admin/*` route is 401 without a valid cookie.

### The write path

- **zod 4's `.partial()` still applies `.default()`.** A PATCH schema built that way would silently rewrite every omitted column to its default. Column defaults therefore live in `src/db.ts` only, and every schema uses `.optional()` — never `.default()` on a patchable field.
- **`UPDATE … SET` is built from `as const` column allowlists** (`MONITOR_PATCH_COLUMNS`, `GROUP_PATCH_COLUMNS`, `INCIDENT_PATCH_COLUMNS`, `MAINTENANCE_PATCH_COLUMNS`), so a column name can never come from a request body. An empty patch degrades to a plain `SELECT` rather than emitting invalid SQL.
- **`incidents.resolved_at` is derived, never accepted.** The API sets it from `status === "resolved"` on both POST and PATCH; `src/db.ts` stays decision-free. The two fields cannot disagree.
- **The maintenance ordering rule is a property of the row, not the body.** PATCH loads the stored window, merges the patch and rejects `ends_at <= starts_at`, so a patch that moves only one end is still validated.
- **Settings carry only what the code honours.** One column, `site_name`, and one field in the form. A timezone or logo column with no reader would be a promise the UI does not keep.
- **The public page now costs six queries, not five** (#6): `getSettings` joined the second wave, because the site name is admin-owned from here on and the `SITE_NAME` constant is gone. Still flat in the monitor count.

### The panel

- **`AdminPage` is the only component that fetches.** Everything else takes props and returns markup. Every mutation is followed by one `load()` refetch rather than an optimistic update: a monitoring tool must never show a monitor it failed to save.
- **Forms are uncontrolled** — one `onSubmit` reading `new FormData(event.currentTarget)`, no `useState` per field. Less code, and it renders identically under `renderToString`, which is what the tests read.
- **`Select` is a styled native `<select>`.** Keyboard and screen-reader behaviour for free, and it participates in `FormData` without plumbing.
- **No router.** `main.tsx` branches on `location.pathname.startsWith("/admin")`; `not_found_handling: "single-page-application"` already serves `/admin` from `index.html`. Sections are `useState` tabs, which are real buttons with `aria-pressed`.
- **One error shape, one reader.** `problem()` in `AdminPage.tsx` is the single place that turns an API error body into a sentence, including the `issues[0]` case and the `invalid_credentials` / `locked` / expired-session wordings.
- **The 60-second floor, the single vantage point and "no ping monitor" appear in the monitor form**, next to the fields they constrain — not only in the public footer the admin never reads.
- **The quota panel is arithmetic, and says so.** `quotaEstimate` is pure over `{ interval_seconds, enabled }`; the card names the Cloudflare dashboard as the authority on actual usage. `percent_used` is computed as `round(writes * 1000 / limit) / 10` — integer-first, so 14.65 does not drift to 14.6 — and a fixed `en-US` `Intl.NumberFormat` keeps SSR and client output identical.

### Three extractions, and one type-environment gap

- **`src/limits.ts` was extracted** once the monitor form needed the same 60 as zod enforces. Importing `src/admin.ts` into the client would have pulled Hono and zod into the browser bundle; a three-constant module keeps `MIN_INTERVAL_SECONDS`, `WRITE_LIMIT_PER_DAY` and `SUBREQUEST_LIMIT` in one place and `src/admin.ts` re-exports them.
- **`frontend/components/ui/field.tsx` is an extra primitive** — the `{ id, label, hint }` wrapper three forms would otherwise have duplicated.
- **Groups got an inline section, not a component.** A group is a name and a visibility flag; one input, a Hide/Publish toggle and a Delete button do not need a seventh file.
- **`crypto.subtle.timingSafeEqual` is declared in `src/auth.ts` via `declare global`.** One tsconfig covers both the Worker and the React client, so `src/**` is checked against `lib.dom`, whose `SubtleCrypto` predates the workerd extension — and the generated runtime types declare `SubtleCrypto` as a *class*, so it cannot merge with the DOM interface. Splitting into separate projects would mean untangling the frontend's type imports from `src/`; a five-line augmentation copied from `worker-configuration.d.ts` is the cheaper answer. Revisit if a second Workers-only API hits the same wall.

---

## 8 — Notifications and auto-incidents

Migration `0004_notifications.sql`. New module: `src/alerts.ts`.

### The three request shapes, verified rather than remembered

- **Discord:** `POST` to the webhook URL the admin pastes, body `{"content": "…"}`. At least one of `content`, `embeds`, `components`, `file` or `poll` must be present, and success is **204 No Content** unless `?wait=true` — so "was it accepted" is `response.ok`, not a parsed body.
- **Telegram:** `POST https://api.telegram.org/bot<token>/sendMessage`, body `{chat_id, text}`. JSON is accepted for every method that does not upload a file.
- **Generic webhook:** Levix's own shape, so Levix defines it — `{site, text, events}`. Discord and Telegram get prose because a human reads it; the webhook receiver is a program, so it gets the structured `events` array as well and never has to parse the sentence.
- **Vendor ceilings are clipped at the request boundary**, not in the summariser: 2,000 characters for Discord, 4,096 for Telegram, uncapped for Levix's own webhook. `channelRequest` throws if a row reaches it without the credential its type needs — that row should have been impossible, and a thrown error in a caught delivery is recorded on the channel rather than silently sent nowhere.
- **No emoji in any message.** `DOWN` and `UP` survive every terminal, log aggregator and mail client a webhook might end up in.

### One message per channel per tick

- **Transitions are batched.** Twenty monitors flipping at once with three channels configured would be 60 external subrequests against a Free-plan ceiling of 50 (#1). One request per enabled channel per tick is inside the ceiling for any monitor count, and it is also the message a human wants: one "3 monitors changed state" rather than three pages.
- **The trade is explicit:** two monitors that fail 30 seconds apart land in different ticks and send two messages; two that fail in the same tick send one. The summary line says how many monitors it covers, so the reader is never misled about what they are looking at.
- **`pending → up` is not news.** A monitor's first successful check announces nothing, because nobody was told it was broken. Any move *to* down is news; `down → up` is news; an unchanged status — including a monitor still inside its retry window, whose status has deliberately not moved yet — is not.
- **`transitionOf(before, after)` takes two statuses, not a monitor.** The checker's retry rule stays the only place that decides what "down" means; `src/alerts.ts` only decides who hears about it. The comparison is free where it happens, because `nextState` has just computed the new status.
- **Delivery is caught per channel.** The error is recorded on the channel row and the tick carries on: a broken Discord webhook must not stop a Telegram alert or fail the cron pass.
- **No retry.** A channel that is briefly unreachable loses that message. A retry queue needs Queues (a Paid binding) or an alarm-driven Durable Object holding an outbox, and inventing a durable outbox for a v1 whose whole promise is one Worker is the wrong first purchase. The recorded `last_error` is what makes the loss visible instead of silent, and the channel form says so where an admin will read it.

### Incidents: the `auto` column is the line between machine and human

- **`incidents.auto` finally exists** — the column migration `0002` predicted. `auto = 1` is a machine-opened incident, and auto-resolve only ever touches rows with `auto = 1` that are open on both `resolved_at` and `status`. An incident someone wrote by hand is never closed by a cron tick.
- **Incidents are the status page's own record**, so they open even when every channel is disabled or none exists. The title is the monitor's name alone (`API is down`) — the page it appears on already carries the site name.
- **Recovery appends rather than overwrites.** `resolveIncident` sets `status`/`resolved_at` and appends `Recovered after 3 minutes.` to the body, so the check message that opened the incident survives next to the outcome.
- **Both policies are global, not per-monitor.** Retries are per monitor because they describe the target; auto-open and auto-resolve describe the instance, and one instance has one admin (#1).
- **Auto-resolve closes an incident after a single successful check**, which will occasionally close a flapping outage early. Waiting for N successes would be a second retry policy to explain, and the incident reopens on the next down transition anyway.

### Channels

- **Per-type configuration is a schema fact.** A table-level `CHECK` in `0004` says webhook and discord carry a `url` and nothing else, telegram carries `bot_token` and `chat_id` and no `url`. One pure `channelRow(merged)` in `src/admin.ts` produces exactly those columns — nulling the fields the type does not use — so changing a Telegram channel into a Discord one cannot leave a stale token behind and trip the `CHECK`. PATCH merges into the stored row before validating, exactly like the maintenance ordering rule in #7.
- **`bot_token` is a stored credential.** It is never in the public payload, only ever read by the Worker, and the admin API returns it as stored — there is one admin and the panel is where it was typed.
- **The channel row is the delivery log.** `last_sent_at` and `last_error` are overwritten by each attempt; an error stays visible until a later send clears it. A `notification_deliveries` table would spend D1 writes on history no screen reads yet.
- **The test button is the same code path as a real alert** — same `channelRequest`, same `deliver`, same recorded result — with a fixed message. A test button with its own code path tests the button. It is a mutation like any other in the panel: run it, refetch, and let the channel row's own last-result line report what happened, rather than a toast that vanishes.

### Shapes that changed while writing it

- **`openAutoIncident` was not written; `createIncident` gained an `auto` field instead.** One insert with one more column is smaller than a second statement that would drift from it.
- **`openIncidents` became `openAutoIncidentFor(db, monitorId)`** — one monitor's currently-open auto incident, which is the only question either caller asks.
- **It also excludes `status = 'resolved'`, not just `resolved_at IS NOT NULL`.** The API always derives one from the other, but a read that depends on that derivation would break quietly if anything ever wrote the columns directly.
- **A duplicate guard was added on the down path.** With auto-resolve off, a monitor that flaps would otherwise open a second incident for an outage that already has one open.
- **`SettingsForm` takes the whole `Settings` row** rather than `siteName` plus two booleans, now that it owns three fields.
- **`tests/tsconfig.json` gained its own `exclude`.** It extends the root config, whose `"exclude": ["tests", …]` was silently excluding every test file — `tsc -p tests/tsconfig.json --listFiles` listed none of them. Fixing it surfaced seven real errors: three `worker.scheduled(controller, env, ctx)` calls against a two-parameter handler, and four incomplete fixtures. The test project is part of `npm run typecheck`, so this was a hole in the gate itself.
- **`scheduled()` gained a third parameter, `_ctx`.** Unused on purpose: every await stays in the handler's own chain rather than `ctx.waitUntil`, because a tool that reports an outage after the next tick is not reporting it. The cron invocation has a minute; this uses it.

---

## 9 — Realtime

No migration — nothing new is persisted. New files: `frontend/lib/live.ts`, `frontend/components/status/live-badge.tsx`, `tests/live.test.ts`, `tests/live-client.test.ts`.

### Hibernation, as the documentation actually describes it

- **The accept path is `new WebSocketPair()` → `this.ctx.acceptWebSocket(server, [tag])` → `new Response(null, { status: 101, webSocket: client })`.** `ws.accept()` is never called: it opts the socket out of hibernation, and with it the `addEventListener` handlers stop firing, because a hibernatable socket delivers to the object's `webSocketMessage`/`webSocketClose`/`webSocketError` methods instead.
- **`webSocketMessage` exists and does nothing.** The keepalive is auto-answered and never reaches it, but an unhandled message would fault the object — and one faulted object takes every other socket it holds down with it.
- **Tags are the routing table.** At most 10 per socket, 256 characters each, and `ctx.getWebSockets(tag)` filters by them. Levix uses exactly one, `public` or `admin`, assigned from the path the Worker forwarded.
- **`ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))`** in the constructor. Request and response are capped at 2,048 characters each, and a match is answered *without waking a hibernating object*, so a client keepalive costs no billable duration.
- **A deploy restarts every Durable Object and drops every connection.** That is survivable only because the client reconnects with backoff and refetches on resume; there is no server-side session to lose.

### The arithmetic that shaped it

- **One RPC call per tick, not one per monitor.** Durable Object requests count "HTTP requests, RPC sessions, WebSocket messages, and alarm invocations", and each `stub.method()` is its own RPC session. Twenty monitors × 1,440 ticks would be **28,800 requests a day** before a single viewer connects; one batched `setStatuses(updates)` is **1,440** against the Free plan's 100,000. This is why the per-monitor `setStatus` from #3 is gone, and it is the same batching the notification path applies (#8).
- **Outgoing messages are free and incoming ones are discounted 20:1**, which is what makes a 50-second client keepalive affordable — comfortably under any idle proxy timeout, and answered by the runtime rather than the object.
- **`MAX_SOCKETS = 256`, and the upgrade past it is refused with 503.** `/api/live` is unauthenticated by design — everything it carries is already on the public page — so a cap is the only thing between an open endpoint and a metered resource. Viewer 257 gets the behaviour that predates this: a page that renders and does not move. WAF rate limiting in front of it looked like a dashboard setting rather than code, which #10 corrects.

### What goes on the wire

- **Two statuses, deliberately.** `status` is the monitor's status — the one the retry window holds still — and `check` is that single check's own result. The retry window is exactly where they disagree, and both screens need the disagreement: a failing-but-not-yet-down monitor shows a red heartbeat segment under a green dot.
- **`monitor_status` is now what the hub stores.** The row used to hold the raw check result; it now holds the monitor status, so the live row and the dot agree. A new test pins it.
- **The frame carries `monitor_id`, the two statuses, the latency and the timestamp — and nothing else.** No name, because the client already fetched the names. No target, for the reason #6 gives. No check message either: a check output can name a target (`getaddrinfo db.internal`), so the admin bar takes messages only from its authenticated history fetch and appends live segments with `message: null`.
- **snake_case on the wire**, matching `/api/status`. One convention per boundary; the client should not have to know which socket a field came from.
- **Role tags are the visibility filter, applied at the send.** `dueMonitors` gained `COALESCE(g.is_public, 1) AS is_public` through the `LEFT JOIN monitor_groups` it already needed, the update carries `isPublic`, and `broadcast` builds the public frame from the filtered list. A monitor in a hidden group therefore never reaches a public socket at all, rather than being filtered by a client anyone can read.
- **Every `send` is caught per socket.** A socket that died mid-tick is not the tick's problem — the same rule #8 applies to a broken channel.

### The client half

- **One socket module, `frontend/lib/live.ts`.** `useLive(path, { onUpdates, onResume })` owns reconnection — 1 s doubling to 30 s — a 50-second `ping`, and a `"connecting" | "live" | "offline"` state. Handlers live in a ref, so a re-render never reopens the connection. Everything else in the file is a pure function over state, which is why the patch logic is unit-tested without a DOM.
- **`wss:` is derived from the page's own protocol**, so the same build works on `vite dev` over http and on the deployed origin over https with no build-time flag.
- **There is no replay on reconnect.** `onResume` fires on every reconnect after the first and refetches instead. Storing undelivered frames in the object's storage to replay them would be a durable outbox — the purchase #8 refused for notifications, for the same reason. A viewer who was offline for a minute sees the gap as a refetch, not as a bar filled in from history.
- **Uptime percentages and charts are not patched live.** One check cannot move a 24-hour average enough to matter, and a client-side aggregate that disagrees with the server's is worse than a number that updates when the window does. The overall word and the up count *are* recomputed, because those are the first things a visitor reads.
- **The page never claims to be live when it is not.** `LiveBadge` renders the state as a word plus a tooltip, never as a colour alone, and the offline copy says what the data on screen actually is: as of the last update received.
- **The admin panel's indicator is a separate component so it can mount late.** `LiveIndicator` calls the hook, so the socket opens only once a session exists — opening it from the login screen would earn a 401 and then reconnect forever.
- **The heartbeat reversal happens once, where the fetch lands.** `recentHeartbeats` returns newest-first and a bar reads oldest-to-newest, so `AdminPage` reverses on arrival and every consumer downstream — including `patchBar`, which appends — sees one ordering.
- **One bar, two screens.** The admin heartbeat view reuses the exported `StatusBar` from the public monitor card rather than growing a second bar with its own rounding.

### What is deliberately not pushed

Incidents, maintenance windows and settings changes stay on the request path. The checker is the only thing that changes every minute; everything else changes when a human clicks, and that human's own `load()` already refetches. There is also no presence, no per-monitor room and no second Durable Object: one hub, one name, `global`.

### Two gotchas, and three shapes that changed

- **The `Upgrade` header has to survive the Worker→Durable Object hop.** `hub.fetch("https://monitor-hub/public")` returned a 101 to a request that, from the object's point of view, was not an upgrade — surfacing as `Worker tried to return a WebSocket in a response to a request which did not contain the header "Upgrade: websocket"` at the *outer* boundary, which points at the wrong hop. The fix is to re-address the original request: `new Request("https://monitor-hub/" + role, request)`.
- **`SELF.fetch` is required to test an upgrade.** A synthesized `new Request(…)` through the imported `worker.fetch` cannot return a socket, whatever headers it carries.
- **`MonitorTable` gained live props** (`openMonitor`, `heartbeats`, `onToggle`) rather than a second component wrapping it, and the existing render tests were routed through one `table()` helper so a future prop does not mean editing four call sites.
- **`dueMonitors` returns `DueMonitor`, not `Monitor`**, which broke a `(t): t is MonitorTransition` type predicate in `src/checker.ts` — a predicate's type must be assignable to the parameter's, and `MonitorTransition.monitor` is the narrower `DueMonitor` there. A plain `.filter((transition) => transition !== null)` narrows on its own and cannot go stale.
- **The socket cap and the keepalive are the two numbers most likely to need tuning in production**, and both are single named constants (`MAX_SOCKETS`, `KEEPALIVE`) for exactly that reason.

---

## 10 — The deploy path

### Why the deploy itself is not automated

- **Only half of a deploy can live in the repository.** The login is an interactive browser flow, and a deploy is outward-facing in a way that cannot be undone by editing a file: the moment it lands, an unauthenticated `/api/live` and an unclaimed create-admin screen are on the public internet. So the repository carries the runbook and the production surface, and `wrangler login`, `d1 create`, `d1 migrations apply --remote` and `npm run deploy` are run by hand from the account's own machine.
- **`wrangler deploy --temporary` was available and was not used.** It publishes to a temporary preview account, which is still a public deploy and not the one the runbook describes.
- **`database_id` stays `"levix-local"` in the repository.** The real id belongs to the account that will host the instance; `wrangler d1 create levix` prints it and `docs/DEPLOY.md` says where it goes. (#16 replaces this with a named placeholder and a script that fills it in.)
- **`docs/DEPLOY.md` is ordered so that claiming the admin is step 7, immediately after the deploy** — before monitors, before channels, before the optional domain. The one-time setup screen (#1) is the single window where a fresh instance is claimable by whoever finds the URL, so the runbook closes it first and says why.

### What the WAF promise turned out to be worth

- **Entry 9 said a rate-limiting rule in front of `/api/live` was a dashboard setting. It is not — not on a `workers.dev` URL.** Rate limiting rules are configured per **zone**, and the `workers.dev` subdomain is Cloudflare's zone, not yours: there is no WAF, no rate limiting rule and no firewall rule to attach to it. #1 chose `workers.dev` with a custom domain optional, so the honest statement is that `MAX_SOCKETS = 256` is the *whole* protection for a default deploy, and a rate limiting rule is one of the things a custom domain buys.
- **The Free plan does include exactly one rate limiting rule, and it is enough for this endpoint**: path-only expressions, counting by IP, with the period and mitigation timeout both fixed at 10 seconds. `/api/live` as a path expression fits inside those constraints, which is recorded in the runbook rather than discovered later.

### The TCP re-probe finally ran, and answered a different question

- **Re-running entry 5's probe gave the identical result.** `example.com:443` (open), `example.com:8081` (closed) and a hostname that does not resolve all stayed silent for more than 8 seconds without an error, while `127.0.0.1:9` rejected with `proxy request failed, cannot connect to the specified address` after **2,091 ms**. Local workerd does not surface remote socket failures at all, so no amount of local probing can tell a TCP monitor up from down. The scratch test was deleted again, and the deployed measurement is a step in `docs/DEPLOY.md`.
- **That 2,091 ms is why `TCP_GRACE_MS` went from 250 ms to 2,500 ms.** If a refusal takes two seconds to surface anywhere near the edge, a 250 ms window would have called every dead port up — the failure mode that matters, because it is silent. The constant is documented as the knob and the runbook has the two-monitor test that calibrates it.
- **Latency is now measured at the handshake, before the grace window.** It was previously taken after it, which meant every TCP monitor reported a floor of 250 ms of made-up latency — and would have reported 2,500 ms after this change. Waiting for silence is the probe's own decision and has no business in a number the charts present as the peer's response time.
- **The docs settled the Free/Paid question by not raising it:** `connect()` has no plan gate. What the platform refuses on every plan is port 25, Cloudflare's own IP ranges, `localhost` and private ranges, and a Worker connecting back to itself. The TCP target hint in the admin form now says what a port check actually proves.

### Small things a deploy needs

- **A favicon, hand-written as `public/favicon.svg`.** A favicon is fetched as a file, so it cannot come out of `reicon-react` at runtime; it is the same pulse mark the hero draws, in the `--up` accent, with a `prefers-color-scheme` swap inside the SVG. Vite copies `public/` into `dist/client` and the assets handler serves it — the dry run reads 6 files where it used to read 5. No PNG fallback, no manifest, no apple-touch icon.
- **The logo is still a placeholder.** A real one is a drawing job, and Uptime Kuma's artwork remains theirs.
- **`README.md` still described the scaffold.** It now describes the project that exists, points at the runbook rather than repeating it, and states the no-default-credentials property where a reader will meet it first.

### What the repository cannot close

- **A deploy path being ready is not a deploy.** The runbook's verification steps — a `scheduled` invocation once a minute, one real Discord or Telegram message, the two-monitor TCP calibration — are the first time those paths run outside the suite, where every delivery is a spy on `globalThis.fetch`.

---

## 11 — Motion and the glass theme

### The override entry 1 gets, and the two reasons it answers

- **Entry 1 said liquid glass is "an accent, not a theme" — hero and overall-status card only. That is overridden here, deliberately: glass belongs on every card surface.** The two reasons #1 gave are answered rather than dropped: **GPU cost** becomes a variable, so `.glass` blurs 12px over 72% card colour and only `.glass-hero` keeps the original 24px over 55%; **legibility** keeps the opaque `var(--card)` base and the `@supports (backdrop-filter: blur(1px))` gate exactly as they were, and cards now sit on *more* paint than the hero does, not less.
- **The backdrop stays static.** A drifting gradient behind N blurring surfaces re-samples every blur every frame. The page is alive because its data moves; `body::before` is still one fixed paint that never changes.
- **Nothing rotates.** The card-tilt recipe is used for its glare layer only: `rotateX`/`rotateY` on a `backdrop-filter` surface re-blurs it every frame, and a status page hero that wobbles under the pointer reads as a toy.

### transitions.dev, consumed rather than installed

- **Nothing is installed, and nothing needs to be.** The catalogue is copy-paste CSS: the recipes were read from the published source — the root stylesheet of tokens plus one numbered file per transition — and copied in by hand. Class names and token names are kept verbatim so the work is recognisably theirs and a future reader can diff against the source.
- **Only the token groups this page has an interaction for were copied** — the shared duration/easing scale plus `tabs`, `acc`, `digit`, `stagger`, `shimmer` and `tilt-glare`. Every colour a recipe shipped as a hex value points at an existing Levix token, so dark mode is the same implementation rather than a second one.
- **Where each of the six landed:** tabs sliding (16) on the hero's 24h/7d/30d/90d switcher · accordion expand (21) on the monitor card's response-time panel, chevron included · texts reveal (18) on the hero headline and monitor count · number pop-in (02) on the status word, uptime, latency and the "N of M operational" line · shimmer text (15) on "Connecting…", "Loading status…" and "Loading response times…" · card hover tilt (19), glare layer only, on the hero glass.
- **Two pieces are local, because the catalogue has no entry for them.** `t-pulse-ring` is a `box-shadow` ring in `currentColor`, so each dot pulses in its own status tone, and `t-bar-seg` is a `scaleY` arrival on one heartbeat segment. Segments are keyed by `checked_at`, so a new check mounts a new element and animates exactly once instead of the whole bar replaying.

### Four deviations from the recipes, each for a stated reason

- **No `role="tablist"`.** The recipe keys off `aria-selected` inside a tablist; #6 chose `aria-pressed` on plain buttons because they switch a view and own no tab panels. The sliding pill is a visual treatment, not a promise of arrow-key tab semantics the buttons do not honour.
- **The pop-in applies to the whole value, not one element per glyph.** Per-character animation breaks text selection and turns "99.95%" into eight strings for a screen reader. `Pop` is keyed by its own value, so React's reconciler replays the keyframe when — and only when — the string changes; there are no timers and no previous-value bookkeeping.
- **`display: block` is left out of the texts-reveal rule**, which would flatten the hero headline's flex row, and no `font:` shorthand was copied onto `.t-tab`, which would beat Tailwind's `text-sm` utility from an unlayered rule.
- **The per-snippet `prefers-reduced-motion` guards are absent.** The global reset in `@layer base` already flattens every transition and animation on the page to 0.01ms with `animation-iteration-count: 1`. Six copies of one rule is worse than one rule.

### The pieces React still has to own

- **The pill's geometry, and nothing else.** A `useLayoutEffect` writes `translate(offsetLeft, offsetTop)` and a width from the pressed button's measured box; CSS owns the tween. The first placement and every resize are written with the transition suspended plus a forced reflow, so the pill snaps into position instead of sliding in from the left on load. `.t-tabs` wraps and `.t-tabs-pill` sits at `top: 0`, so a second row still positions correctly and the JS carries no hardcoded padding.
- **The glare is written straight to the node.** `--tilt-gx`/`--tilt-gy` and `.is-hover` are set through `classList`/`setProperty` in the pointer handler: a `pointermove` that re-rendered the hero would cost a React pass per frame. *(Removed in #13 — nothing on the hero should answer the pointer, so recipe 19, its tokens and its handlers are all gone. Five recipes on this page, not six.)*
- **The accordion panel stays mounted** so `grid-template-rows: 0fr → 1fr` has something to animate, with the padding on the inner element because padding on a 0fr track leaves a visible strip. It carries `aria-hidden` while collapsed, and the chart inside stays conditional on fetched history — a status page should not animate open onto stale numbers.

### Where motion is allowed to mean something

- **Exactly one place: the live badge's dot pulses while the connection is live and the word shimmers while it is opening.** That is also the one place the reduced-motion reset removes information, which is why the state has always been a word and a tooltip as well (#9). `Live` and `Offline` are states, not activity, so they do not shimmer; a `pending` monitor's dot does not pulse, because it has nothing to pulse about.
- **No number is in motion while it is being read.** The pop-in is a 500ms entrance on a value that just changed, not a loop, and the exact strings `formatUptime`/`formatLatency` produce are unchanged — which is what keeps the render tests meaningful and the numbers selectable.

### What was deliberately not built

A motion library. The 21 catalogue transitions this page has no interaction for. Hover lift on cards. Animation on the admin's tables and dialogs — the admin's containers get the glass surface and stop there. A skeleton screen, when shimmer on the one loading line says the same thing without a parallel component tree. `feDisplacementMap`, still the expensive half of "liquid glass". A real logo, still deferred.

### What the suite cannot cover

**It cannot see motion.** Rendering components to strings proves that `data-open` flips, that a collapsed panel is `aria-hidden`, that `data-text` matches the shimmered string and that the values carry the pop class — but not that the pill lands where it should, that the glare tracks the pointer, or that 12px of blur is still legible over the backdrop. #6's open item stands: that verdict comes from a browser.

---

## 12 — The industrial-design pass

### What it answers

The motion pass in #11 wired six catalogue transitions to interactions that already existed and called the result alive. It was not: the heartbeat bar was still a row of table cells, the admin panel got a `glass` class and nothing else, and eleven of the catalogue's transitions had no home. This pass rebuilds the bar against the reference design, gives each of the eleven an interaction — inventing the interaction where there was none — and takes both surfaces through the same industrial-design pass. No route, table, binding, migration or dependency changed; everything is in `frontend/`.

### The bar gets its own tone set, and why it is not `--up`

- **The reference's green is a bright emerald, near `oklch(0.78 0.19 152)`. Light-mode `--up` is `oklch(0.58 0.15 148)` and has to stay there**, because `text-up` is read as text and the emerald fails contrast as a glyph. So the bar has four tones of its own — `--up-bar`, `--degraded-bar`, `--down-bar`, `--pending-bar`, both themes, exposed through `TONE_BAR` in `lib/format.ts` — and they are never used for a glyph. Raising `--up` instead would have traded a legible status word for a prettier bar.
- **The empty tone inverts between themes** (`oklch(0.9 0.01 255)` light, `oklch(0.34 0.01 255)` dark) while the three coloured fills only lift slightly: a pending segment that kept its light value would glow in the dark theme.
- **The bar is stadium segments, not cells.** `rounded-full` with a radius larger than a segment is wide, a 28px track, a real 3px gap and `flex-1` distribution with a 3px floor, so the row reads as capsules at any count. `role="img"`, the "Last N checks for …" label and the per-segment `title` survive, and so does `t-bar-seg`'s keyed arrival — a new check mounts a new element and animates once instead of replaying the whole bar.
- **The card header follows the reference**: dot, name and type left; the uptime percent hard right, bold, tabular, larger; the bar beneath; and the status word, latency and check time demoted to one quiet line under it with the disclosure at its right. Four values crowded onto one line was the old design's actual problem.

### The eleven, and the interaction each one drives

Four were already in the page and were widened; seven needed an interaction that did not exist, and inventing it was the work. In every case the invented interaction is one the panel wanted anyway.

- **number-pop-in (02)** — the monitor status word and latency, the hero's "N of M operational", and now all five quota figures. Adding a monitor moves five numbers at once, and noticing which way they moved is the panel's whole purpose.
- **texts-reveal (18)** — the hero headline on first paint, and every admin section's header on tab change. The tabs unmount each other, so the reveal replays per switch for free.
- **tabs-sliding (16)** — the hero's window switcher *and* the admin's four sections, from one `Segmented`. The admin's old `<nav>` of `aria-pressed` buttons was this control drawn worse.
- **accordion (21)** — the monitor card's response-time panel *and* the admin table's heartbeat panel. The table had a second, ad-hoc implementation with a `rotate-180` chevron and an unmounted panel; two accordions in one app is one pattern too many.
- **spinning-counter (26)** — `Reel` on the bold uptime percent, keyed to the window so it re-rolls when the visitor asks for a different period.
- **Toggle (27)** — the five raw admin checkboxes, plus per-group Publish/Hide, which was a boolean wearing a verb.
- **menu-dropdown (05)** — `RowMenu`: Edit / Delete / Test collapse behind one `⋯` in every admin list. Three rows of buttons becoming three rows and one glyph is the actual move here.
- **Dropdown menu morph (20)** — the theme control. It was a blind three-state cycle: one button, one icon, and the only way to learn the options was to press it three times. Now the round trigger's own box grows into a System / Light / Dark panel.
- **Spinner to check morph (10 + 09)** — every admin mutation. The catalogue settles the ambiguity: "The success check is animation-only — if you also need to swap from a spinner to the check, pair it with **icon swap**." So it is those two, not the checkbox-check recipe.
- **success-check (10)** — the same draw, and the channel Test result.
- **error-state-shake (12)** — a rejected sign-in, a failed mutation, and the setup form's password mismatch.

### The three references, and what each was allowed to cost

- **orbs.jakubantalik.com → `Orb`.** A 2D canvas dot-lattice sphere: 17 latitude rings, longitude count scaled by ring radius, dot size and ink alpha driven by `sin`/`cos` depth. No WebGL, no shader, no library. The engineering discipline is copied whole because it is the part worth copying: `devicePixelRatio` capped at 2, the rAF loop paused by `IntersectionObserver` and `visibilitychange`, one static frame and no loop at all under `prefers-reduced-motion`, and a `MutationObserver` on the root element's class so a theme flip redraws a still orb instead of leaving it in the old ink. It is `aria-hidden` decoration on one surface at 112px, and it turns at a constant speed whatever the status is — motion that carried meaning would take that meaning away from everyone who asked their OS for less of it (#9). The tone only tints it.
- **gooey.jakubantalik.com → the sliding pill's blob.** The metaball chain verbatim: `feGaussianBlur` → `feColorMatrix` pushing the blurred alpha through a steep contrast → `feComposite atop` compositing the original graphic back inside the resulting silhouette. The alpha row is the recipe's own formula `0 0 0 C (0.5 - C * 0.41667)` with C = 18, so `0 0 0 18 -7`. The filtered layer holds the pill and a ghost that lags behind it and *no text*: the filter composites to the blob's silhouette, so a label inside it would be clipped wherever the blob is not. Labels sit above, unfiltered.
- **freefrontend.com/css-liquid-glass/ → the glass itself.** The cheap half everywhere — layered inset `oklch()` specular highlights, a `--glass-saturation` token, and the FAQ's `contain`/`will-change` fence. The expensive half on the hero alone: `levix-refract`, a fractal-noise field blurred into a height map, displacing the backdrop three times at scales 26 / 20 / 14, each pass reduced to one colour channel and screened back together — which is what puts the faint red/blue fringe on high-contrast edges that real glass has — then a 0.4px blur to soften the seam a displacement leaves at the card's own border. The flagship demo reports "GPU Accelerated: No", so refraction gets exactly one surface, and it is off under reduced motion.

### Every deviation from a recipe, each for a stated reason

- **The switch drops recipe 27's two keyframe sets and its `.is-init` class.** The thumb travels on a `translate` transition with the recipe's overshoot easing instead. A transition does not run on first paint, so the mount-bounce `.is-init` exists to suppress cannot happen, and the class is dead weight.
- **The morph's open box is hardcoded to this control's footprint, not the recipe's.** Recipe 20 warns the open width and height must be literal — a box animating to `auto` cannot tween — so they are 150×120: three 36px rows, two 2px gaps, 4px of padding. The recipe's own 183×172 would have opened a panel with empty space in it.
- **The icon swap runs three icons in one grid cell, not the recipe's pair.** `.t-icon-swap` matches on a name (`data-icon`), so one selector covers Desktop / Sun / Moon.
- **The check is drawn over the path's real length.** `@keyframes t-check-draw` is `to { stroke-dashoffset: 0 }` only, so the `from` is whatever the component wrote inline; `Pending` measures `getTotalLength()` on mount and writes both dash properties, instead of copying the recipe's placeholder dasharray, which would only be right for the recipe's own path.
- **`t-spin` sits on the inner `<svg>`, not on the `.t-icon` wrapper.** An animation on an element overrides transitions of the same property on that element, and the swap animates `transform` too — on the wrapper the spin would have eaten the scale leg of the exchange.
- **Only the shake is taken from recipe 12.** Its `.t-error-msg` reveal and 3-second auto-revert are React's job here: the message is a conditionally rendered `role="alert"` that must stay until the next attempt rather than fade out from under the reader. `.is-shaking` stays orthogonal to `.is-error` so a replay does not flicker the error state, and `.t-input.is-error` owns the border colour from the same unlayered rule that would outrank a Tailwind utility anyway.
- **One shake mechanism, keyed on a counter.** A CSS animation only replays after remove → read a layout property → add, so `useShake` does exactly that and takes an attempt *count*, not the message: the same rejection twice has to shake twice. The login card cannot be keyed for a remount instead — that would wipe its uncontrolled inputs — and mixing a keyed remount for the alert with a JS replay for the card would be two coexisting styles for one behaviour.
- **The reel's motion streak is an SVG filter, not CSS `blur()`.** `stdDeviation="0 3"` blurs along the axis the digits travel; a symmetric CSS blur smears a 10px-wide digit sideways into mush. It is toggled per column while that column spins.
- **`RowMenu` claims `aria-haspopup` and `aria-expanded` and deliberately not `role="menu"`/`menuitem`** — the same reasoning #6 gives for the switchers: menu roles promise arrow-key navigation, and a screen reader that switched into menu mode would stop Tab from working. Tab is what the panel actually supports. Its closing class is cleared by a timer, which the catalogue's own common-mistakes list insists on: without it the next open starts from the closing scale.
- **The dropdown hides with `visibility`, not `display` or a conditional mount.** A panel left at `opacity: 0` is still focusable and still read aloud; `display: none` would kill the opening transition because the element has no previous computed style to leave from.
- **`aria-pressed` stays on both switchers, so still no `role="tablist"`** (#6, carried forward from #11).
- **The refraction is a second, separate declaration.** `.glass-hero` re-states `backdrop-filter` with the `url("#levix-refract")` chain appended, so a browser that cannot parse the function list drops only that line and keeps `.glass`'s plain blur — the failure mode is #11's hero. It is on the hero's *own* `backdrop-filter` rather than an extra child layer, because a child with its own `backdrop-filter` would sample the parent's already-blurred flat background. And because a backdrop filter affects only what is behind an element, the displacement can never reach the hero's text: the copy stays sharp while the page behind it bends.

### What the admin's pass actually consisted of

- **One mutation lane for the whole panel.** `AdminPage` holds a single `pending: "idle" | "busy" | "done"`; `busy` is derived from it rather than stored, because two booleans for one request is how they end up disagreeing. Every form takes `pending`, and the button that was pressed is the one that spins and then draws its check.
- **A form that saved closes only after its check has landed.** `run()` used to close the panel on success, which unmounted the button before anything could be seen; the close moved into the `DONE_MS` (1,200ms) effect that also drops back to idle.
- **The channel test reports on its row.** Moving Test into the row menu left it with no button of its own to spin, so `ChannelList` takes `{ id, state }` and the row shows the spinner and the check.
- **One row language across all four admin surfaces.** Monitors, incidents, maintenance, channels and now groups all use `glass divide-y rounded-xl border` lists with a `⋯` menu at the right; the groups list's loud red Delete button was the last holdout. Every panel on both surfaces is `rounded-xl`.
- **`SectionHeader` gives each tab a title, one line of what the section actually does, and its action** — the Monitors header is where the 60-second floor and the single vantage point are stated, Notifications says one message per state change rather than one per failed check, and Maintenance says a window shows as a banner while it is open.
- **`SvgDefs` mounts the three filters once per document**, because they are referenced from CSS by id, and it is mounted *last* in each shell: `space-y-*` margins every child after the first, so a zero-sized filter host at the top would push the page down. It is absolutely positioned at zero size rather than `display: none`, which makes filters unreliable across engines.

### Tests, and the one thing they cannot cover

- **277 tests pass, up from 269.** The eight new ones assert what a `renderToString` smoke test can actually see: the bar's segment count and its bar-tone fills (distinguished from the flat `bg-up` the status dot still wears), the reel's single `sr-only` string, the switch's `t-toggle` class and its `name`s, the row menu's `aria-haspopup` with both disclosures per row reported shut, the theme panel's `data-open`/`aria-expanded` and its three options with exactly one pressed, `Pending`'s `data-state` on the pressed button and on the tested row only, the orb's `aria-hidden` and its tone, and the admin nav's four labels in the same gooey pill layer as the hero's. `TAB_OPTIONS` is exported from `AdminPage` for that last one — the nav's labels are part of the contract, and the nav itself is unreachable in a server render.
- **Five assertions moved rather than broke.** The card's check time is now lowercase inside a longer line, the uptime is a reel and not a pop, Edit and Delete are menu items instead of two labelled buttons, the heartbeat panel is always mounted so "Loading heartbeats…" is present while collapsed, and the test action's label is plain "Send test message".
- **The suite proves the markup and the accessibility contract, never the paint.** Whether the refraction is beautiful or a smear, whether the blob pinches or wobbles, whether 28px capsules at 30 segments read like the reference — that is a browser's verdict.

### What was deliberately not built

A motion library, and still no dependency of any kind. A WebGL or shader path for the glass — the reference's own FAQ recommends native CSS plus SVG for the DOM semantics. Refraction on anything but the hero. An orb whose speed or shape encodes status. Per-character text animation, which turns "99.95%" into eight strings for a screen reader. A design-token package or theme editor. The drifting backdrop, for the reason #11 gave. Animation on the admin's forms beyond the button that was pressed. A real logo, still deferred.

---

## 13 — Fit and finish

### What it answers

The first look at #12 in a real browser. The verdict was fit and finish rather than design: the `⋯` row menus sit out of line in every admin list, two form labels read as cheap, the theme panel's hover pill runs into its own border, the hero's orb should be the reference's Connecting web rather than a dot lattice, and the app should be set in Nunito Sans. No route, table, binding, migration or dependency changed.

### The row menus were one bug wearing four hats

- **`frontend/index.css` is unlayered, and Tailwind's utilities are in `@layer utilities`.** An unlayered rule beats every layered one whatever its specificity, so `.glass { position: relative }` outranked the `absolute` utility on the very same element — and `RowMenu`'s panel is `t-dropdown glass absolute …`. The panel never left the flow: 160px of it sat inside the row, adding its own height to the row and pushing the trigger about 160px left of the row's right edge. That is the whole of the misplacement, in four lists at once, and it is why the theme control was never affected: `.t-morph` declares its own `position: absolute`.
- **The fix is `position: absolute` on `.t-dropdown`, not a nudge per list.** Declared in the same unlayered file, after `.glass`, so it wins by order. Four `margin`/`translate` patches would have left the row heights wrong and the cause in place.
- **Out of flow, the panel is then clipped** by `.glass`'s `overflow: hidden` and the `paint` leg of its `contain`. `.glass-popover` relaxes exactly those two on the four surfaces that host a menu — layout and style containment stay, so the blur is still fenced — rather than weakening `.glass` for every card that hosts nothing. `RowMenu`'s doc comment says its host must carry it, because the failure is silent: the panel is simply cut off at the card edge on the last row.
- **A `renderToString` test can see the opt-out class but never the clip.** Both list components assert `glass glass-popover`; the CSS half is unreachable from a workerd test, and is documented instead.

### Two labels, two different answers

- **"New group" became the input's own placeholder** — `Add new group`, with the name kept through `aria-label`. A placeholder is a hint and vanishes the moment anyone types, so it can be the *visible* label of a field whose whole job is written in it, and cannot be the accessible one.
- **"Site name" was explicitly not allowed that treatment**, and it is the field whose value becomes the public page's heading. So it is one inset row instead, the way a system settings pane does it: the label leads the row, the value is edited in place at its right, the 32-character constraint sits underneath. The row carries the border and the focus ring so the whole cell lights up; the input inside it is stripped of both. *(Superseded by the second look below — the row was replaced and the label became the field's caption. The border, the focus ring and the constraint line stayed.)*
- **The theme panel's padding went 4px → 8px**, which moves `--morph-w-open`/`--morph-h-open` to 156×128 — recipe 20 requires the open box to be literal, so the tokens are part of the padding. The row menu's panel took the same 8px and widened `w-40` → `w-44`, or "Send test message" would have wrapped. *(The tokens are 158×130 as of the second look: the border was missing from the arithmetic.)*

### The orb is now the reference's `web` renderer

- **Connecting, read off the reference's own parameters**: `nodeN` 30 and `signals` 5 at the 64-tier `count` of 1.35, so 41 nodes and 7 signals; `thr` 0.72; `nodeR` 1.4 and `nodeRDepth` 1.8; `lineW` 0.8; the tier's `speed` 3.315 as the clock every other rate is read against. Nodes rest on a fibonacci sphere, get pulled off it by three out-of-step waves and pushed back onto it, then spin about the vertical and tilt towards the viewer. Any two closer than the threshold are linked, with alpha falling off by both gap and depth; radii twinkle; signals hop between hash-picked nodes and fade in and out of them, which is the reference's own shortcut and hides the jump between hops.
- **A network settling into itself is the right picture for this page** — the thing being watched is a set of endpoints and the paths between them — but it is still decoration under #9: constant speed whatever the status is, `aria-hidden`, dpr capped at 2, the loop paused off-screen and on a hidden tab, one still frame and no rAF at all under `prefers-reduced-motion`, and a redraw on a theme flip. Per frame it is 820 distance checks on a 112px canvas.
- **The colour rule was already the code's rule**, so nothing changed for it: `overallStatus` returns `down` only when nothing is up and `partial` when the page is mixed, `overallTone` maps `partial → degraded`, and `TONE_TEXT` resolves to `--down` at hue 27, `--degraded` at hue ~80 and `--up` at hue 148. All-down red, some-down amber, all-up green.

### Nunito Sans, by link

- **A Google Fonts `<link>` with preconnect and `display=swap`**, one variable file covering 300-800, the family first in `--font-sans` and the platform stack still behind it. `display=swap` means first paint is in the system font rather than held on a network round trip — which is also the fallback on an instance with no outbound access, and the reason the stack stays. Self-hosting the woff2 would put a binary in the repo and an asset in the bundle to save one request; the link is two lines and no build change.
- **The optical-size axis comes along for free** and the app already asks for 400/500/600/700, so the whole range costs one file.

### Tests, and what is still unseen

- **279 tests pass, up from 277.** The two new ones assert what a server render can see: the popover opt-out on both list surfaces, and the site-name label sitting immediately before its input on one row. Nothing broke — the site-name rework keeps the same `for="settings-site-name"` the old field had.
- **The paint still needs the browser.** The CSS cascade fix is verified in the built stylesheet, not on screen; whether the Connecting web reads at 112px, and whether Nunito Sans suits the type scale, is a look.

### What was deliberately not built

Per-list positioning patches. A portal for the menu panel. A weaker `.glass`. A self-hosted font pipeline. Any redesign the review did not ask for.

### The second look

The pass held up, with four leftovers, and two of them were the same arithmetic mistake twice.

- **The theme trigger's glyph was a pixel out, and so was the panel's bottom padding: one cause.** An absolutely positioned child is placed against its ancestor's *padding* box. `.t-morph` is a 36px border box with a 1px border, so that padding box is 34px — and a 36px `.t-morph-plus` pinned at `inset: 0 0 auto auto` therefore sat one pixel left of the round box and one below it. Measured off the screenshots, the Sun and Moon ink was 0.5px left and 1.5px low against a 36px circle, which is that offset plus antialiasing. The trigger is now pinned at `-1px -1px`, so its box and the round box coincide. The same border ate the panel's clearance: `.t-morph-menu` is `inset: 0`, so 128px of content (8px padding, three 36px rows, two 2px gaps) had 126px to sit in and the last row's hover pill landed on the border — visible in both themes, obvious in dark. `--morph-w-open`/`--morph-h-open` are now 158×130: the content footprint plus the border on each side. Recipe 20 makes those tokens literal, so the border belongs in their arithmetic.
- **A group's Switch says `Hidden`, not `Hidden from the status page`.** The label is the switch's accessible name and it sits beside the group's own name, which already supplies the context the long form spelled out.
- **The site-name row is replaced, not adjusted.** Label left and value right is what a narrow system-settings pane does; this pane is wide, so it put the two ends of one field a screen apart and read as a stranded placeholder. It is now the field Apple's own forms use: the label inside the box as a small caption, the value set directly under it at the size it will be read at, the box capped at `sm:max-w-sm` because a 32-character name does not need the pane's full width. Same `for="settings-site-name"`, same real label, same constraint line underneath.
- **Neither fix is pixel-verified.** The box model and the built stylesheet are the evidence; the screenshots gave the direction of the offset.

### The third look

- **An open row menu was painted over by the next card, and `z-index` on the panel could not have fixed it.** `.glass` is a stacking context twice over — `backdrop-filter` makes one and the `will-change: transform` beside it makes another — so the panel's `z-20` only ordered it against its siblings *inside* the card. The card that follows is a later positioned sibling at `auto` and won regardless. The "Delete" row bleeding faintly through the Groups card's own translucency is what paint order looks like rather than clipping. So the card rises instead: `.glass-popover:has(.t-dropdown.is-open, .t-dropdown.is-closing) { z-index: 20 }` — only while it holds a panel that is open or still closing, 20 because every other card is `auto` and the theme control's 30 should stay above a card whose menu is on its way out. `:has()` keeps this in CSS: the alternative is threading the open row's id from `RowMenu` up into whichever list contains it.
- **A group's state word gets a fixed slot.** "Public" and "Hidden" are not the same width, and the toggle and the `⋯` sit after the word, so a mixed list had every row's controls at a different x. The word is now `inline-block w-14`; the rest of the row was already aligned.
- **Recipe 19 is gone from the hero.** The pointer-tracked glare, its three tokens, its `.t-tilt-glare` rule and the four pointer handlers are all removed: nothing on the status page should answer the cursor for decoration's sake. The stylesheet is 0.8 kB smaller and the hero no longer runs a `getBoundingClientRect` per pointer move. Motion on the page is now what the page's own events cause.

---

## 14 — The local demo

### What it answers

A local run had nothing worth looking at: no data with any shape to it and no account to sign in with. Nothing about the app was wrong for that, so this is tooling rather than a feature — `npm run demo` seeds the local database and starts Vite, `npm run demo:seed` re-seeds between takes, and `docs/DEMO.md` is the run of show.

### A local seed is not a shipped default credential

The two are worth separating precisely, because #1's no-default-credentials rule turns on it. Nothing in the deploy path creates an account: no migration writes to `admins`, `wrangler deploy` does not run this script, and a fresh instance still shows the one-time create-admin screen. What `scripts/demo.mjs` does is stand in for that screen on a development machine, writing through `wrangler --local` to the SQLite file under `.wrangler/state`. The password is in the script in plain sight, deliberately: it is meant to be typed on camera, and a demo credential that pretends to be a secret is worse than one that admits what it is.

The hash is the app's own. The script imports `hashPassword` from `src/auth.ts`, so the row is indistinguishable from one the setup screen would have written, and then verifies it with the app's own `verifyPassword` before writing — a hash that did not verify would be a login that failed while recording. That call needs `crypto.subtle.timingSafeEqual`, a workerd extension node does not have; the script fills it in with a `Buffer.equals` in one line rather than reimplementing the comparison.

### Why the data is SQL and the script is `.mjs`

The seed is 8,500 rows: a day of per-minute heartbeats for five monitors, 7 days of hourly buckets, 90 days of daily ones. SQLite generates all of it from three recursive CTEs, so there is no row generator to maintain, and every timestamp is written relative to `unixepoch()` — a fresh seed reads "checked just now" instead of reading as whenever the file was written. The three outages in the raw heartbeats are counted in the rollups too, or the same monitor would say 99.7% over 24h and a flat 100% over 7 days, since each window reads exactly one table (#6).

The script is `.mjs` because `scripts/` is outside both tsconfigs and the repo has no `@types/node`: a `.ts` file there would either fail `npm run typecheck` or need a third tsconfig to exclude it. Plain node runs it, and node 24 strips the types out of the `src/auth.ts` it imports.

### What the demo deliberately cannot show

The cron trigger does not fire under Vite, so no check runs while recording and the seeded picture holds still — which is what filming wants. It also means nothing arrives over the WebSocket: the live badge says Live because the socket is open, and that is all it claims. One tick can be forced through miniflare's `/cdn-cgi/handler/scheduled`, which does exercise the realtime push, but it runs *real* checks against the placeholder targets and they fail: tried once, it appended six failing heartbeats and would have flipped monitors down and opened incidents a few ticks later. `docs/DEMO.md` records it as an option with that cost, and re-seeding undoes it.

### Verified

The seeded credential logs in through the real API and `/api/admin/session` agrees; `/api/status` reports `partial`, 3 of 5 up, 40-segment bars; all four history windows return points from their own table; the badge renders; the public WebSocket upgrades. Typecheck, 279 tests and the build stay green — the seed touches no shipped code, so there is nothing new for the suite to assert.

---

## 15 — The rename to FlarePulse, and the footer mark

### What it answers

A new name, the mascot as the project's icon, and one centred line of chrome — name plus mark — on both the status page and the admin panel.

### What the rename touched, and what it deliberately did not

Live code, config, UI strings, tests and the two runbooks were rewritten: the Worker name and the D1 name in `wrangler.jsonc`, the package name, the document title and the boot script's theme key in `index.html`, `/api/health`, the session cookie (`flarepulse_session`), the badge's clipPath id, the three SVG filter ids and the CSS that calls them, the demo seed and its password, and the `flarepulse.test` host plus the `[FlarePulse]` alert prefixes in the suites.

Entries 1–14 of this file were left exactly as written. They are the record of what was decided and when, and a record that has been edited to agree with the present is not a record. This entry is where the new name enters the log. The applied migrations keep their headers and `0003` keeps `site_name TEXT NOT NULL DEFAULT 'Levix'` for the same reason: the schema is append-only, so `0005_rename_to_flarepulse.sql` corrects the one row that default ever produced — `UPDATE settings SET site_name = 'FlarePulse' WHERE site_name = 'Levix'`. It runs after `0003` on a fresh database and after the old default on an existing one, and the `WHERE` clause means an instance that has already set its own site name through the Settings tab keeps it.

One consequence to know about before deploying: the Worker's name is what the workers.dev hostname is made from, so the URL is now `https://flarepulse.<subdomain>.workers.dev`. Nothing is deployed yet, so this costs nothing today. The D1 entry is a subtler case — the database that exists was created as `levix` and `database_name` now reads `flarepulse`. `wrangler deploy` binds by `database_id`, which is untouched, so the deploy is unaffected; if a `wrangler d1 … --remote` command cannot find `flarepulse`, the fix is to put `database_name` back to the name the database was actually created with.

### The mascot is an asset, not a component

`public/flarepulse-mascot.svg` is served as a static file and used twice: as the favicon in `index.html`, replacing the Reicon pulse glyph that stood in for a logo, and as the mark in the footer line. It is an `<img>` in both places rather than an inlined `<svg>`. Inlining it would put two elements carrying the ids `flareGrad` and `pulseGrad` on the same document the moment anything else drew the mascot, and the browser resolves a duplicate id to the first one it finds — the second copy would take the first one's gradients. As a file it is also cached once and reused, which the favicon request already pays for.

`public/favicon.svg` is gone rather than kept as a fallback. A browser that cannot render an SVG icon has not existed for years, and two icon files would be two things to keep in agreement.

### The footer line

`frontend/components/powered-by.tsx` is the whole of it: "Powered by" plus the wordmark in the foreground colour and semibold on one centred line, and the mascot centred underneath it at 56px. The reference lockup puts a monogram inside the line of text; this mark is a whole character with a ground shadow, and sized to the line it disappeared — so it moved below the words and grew instead. Two things made it read as small at first: the box, and the file. `viewBox="0 0 160 170"` had wide empty margins around artwork that only spanned roughly x 26–134 and y 51–165, so a 48px box drew a 30px character; the viewBox is now cropped to `24 48 112 120`, which makes the box size the drawn size and sharpens the favicon for free. There is no gap between the line and the mark and the line carries `leading-none`: the line box's own leading, not the flex gap, was most of the space between them.

One component in `frontend/components/`, used by the status page's existing `Footer()` in place of its old `Powered by …` sentence and by the admin `Shell`, which had no footer at all and now has one behind the same `border-t pt-6` the public page uses. Every admin branch renders through `Shell`, so the line is on the login and setup screens too.

The signed-out screens are vertically centred, wear the mark above the card, and their card is as tall as its form. `Shell` takes a `centred` flag that the session probe, the setup screen and the login screen pass: one small card on an otherwise empty page belongs in the middle of the viewport, and `min-h-svh` rather than `min-h-screen` because a mobile browser's toolbar should not push the card off centre. The footer drops its top border there — a rule the width of the panel under a card the width of a form looked like a mistake — and drops the mark with it, because the flag also puts a `<Mascot />` above the card: one page, one mascot, which is what `PoweredBy`'s `mark` prop is for. The signed-in panel is taller than the viewport anyway, so it keeps the bordered footer with the mark under the words.

The login card was briefly a 1:1 box, and is not one now. Square, the two-field form left an empty band under the button that read as a bug rather than as breathing room, so `Card` lost its `square` flag and is back to `max-w-sm` at whatever height the fields need — 384×305 for login. Two things are worth keeping from the attempt. The card carries `w-full`, without which its width is indefinite and anything derived from it resolves the wrong way round. And the centring flag adds its classes to the existing container rather than wrapping it, which is load-bearing: wrapped, the `mx-auto max-w-4xl` div became a flex item, and auto cross-axis margins cancel a flex item's stretch, so the container shrank to fit its contents, the card's `w-full` resolved against that instead of against 384px, and the two settled at 246px — too small for the form's own 274px, which `.glass`'s `overflow: hidden` then clipped, cutting the Sign in button in half.

`PoweredBy` stands off from what precedes it with `pt-8`. On the status page the three limitation paragraphs run right up to it otherwise, and the line reads as a fourth paragraph rather than as a signature.

The mark carries `alt=""` in both positions. It is decorative: the wordmark it always appears with already says the name, and a screen reader that announced both would say "FlarePulse FlarePulse".

### Verified

Typecheck clean, 281 tests in 14 files (the two new ones assert the line on both surfaces), build green with the mascot in `dist/client/` and the icon link in the built `index.html`. `npm run demo:seed` applied `0005` to the local database and `/api/status` came back naming FlarePulse. What no test can check is whether the lockup looks right.

---

## 16 — Packaging the repository for a one-command deploy

The deploy was already documented; it was not yet *simple*. Getting from a clone to a live instance meant reading a runbook, copying a UUID between two terminals and remembering which of the two migration commands to run first. This entry is what replaced that.

### `database_id` ships as a placeholder, and a script fills it in

`wrangler.jsonc` now carries `"database_id": "REPLACE_WITH_YOUR_DATABASE_ID"` in the committed file and in the working copy. The old arrangement — the real id present locally, the file deliberately never staged — was a convention that only worked for one person and quietly broke the moment the repository became public.

What made this safe to change is that the id in question was worthless: `wrangler d1 list --json` showed the account's `levix` database with `num_tables: 0`, so nothing had ever been deployed or migrated against it. There was no data to strand.

`scripts/setup.mjs` is the replacement. It requires `wrangler whoami` to succeed — the login is an interactive browser flow and stays a human step — then reuses a UUID already in the config, or finds the database by name in `wrangler d1 list --json`, or creates it, writes the id back into the file with a targeted `replace`, and hands over to `npm run deploy`. It reads the config with a regex rather than `JSON.parse` because the file is JSONC and the comments in it are the documentation for the bindings.

### `deploy` chains the migration, and names the binding

`"deploy": "npm run db:migrate && vite build && wrangler deploy"`, where `db:migrate` is `wrangler d1 migrations apply DB --remote`. Two decisions in one line.

Migrations run *before* the upload, because the Deploy to Cloudflare button provisions D1 and rewrites the generated ids but does **not** apply migrations. A button deploy with an unmigrated schema is a Worker that 500s on its first request, so chaining is not tidiness — it is the thing that makes the button work at all.

`DB`, the binding, not `flarepulse`, the database name: wrangler accepts either, and the button names the database it creates after the fork. Naming the binding is what survives that rename. `wrangler` skips its confirmation prompt in a non-interactive environment, so the chained command does not hang in CI or under the button.

### MIT, and CI that gates but does not deploy

MIT because the project has no dependency that argues otherwise and nothing about it wants to be a commercial licence question.

`.github/workflows/ci.yml` runs `npm ci` then the same three commands every gate has used — `npm run typecheck`, `npm test`, `npm run build` — on pushes to `main` and on pull requests. There is deliberately no deploy job: a deploy would need a `CLOUDFLARE_API_TOKEN` in repository secrets, and a token that can write to the hosting account is a larger blast radius than a one-person project earns. Releases stay a deliberate `npm run deploy` from a maintainer's own machine.

### What the repository does not carry

`.gitignore` covers the build output and local state, editor and tooling scratch, and the reference screenshots and debug captures used while designing — none of which belongs in a clone.

`docs/images/status.png` and `docs/images/admin.png` are the two screenshots in the README, captured from a locally seeded instance. Getting them was the one genuinely awkward step: `firefox -screenshot` fires on the `load` event, so a page that fetches its own data screenshots its loading state, and a top-level `await` in a temporary entry module did not hold `load` open. What worked was a `1×1` image pointing at a local server that sleeps four seconds — a pending subresource does hold `load` — with the temporary harness deleted afterwards. Worth knowing the next time a painted capture is needed.

### Verified

`node --check scripts/setup.mjs`, then the full gate: typecheck clean, 281 tests in 14 files, build green. The deploy path itself is still unrun — `wrangler login` and the account belong to whoever hosts the instance, and `npm run setup` is the first thing they run.












