import { useCallback, useEffect, useState } from "react";
import type { QuotaEstimate } from "../src/admin";
import type {
  AdminMonitor,
  Heartbeat,
  Incident,
  MaintenanceWindow,
  MonitorGroup,
  NotificationChannel,
  Settings,
} from "../src/db";
import type { LiveStatus } from "../src/monitor-hub";
import { LoginForm, SetupForm, type Credentials } from "@/components/admin/auth-forms";
import { ChannelForm, type ChannelBody } from "@/components/admin/channel-form";
import { ChannelList } from "@/components/admin/channel-list";
import { MonitorForm, type MonitorBody } from "@/components/admin/monitor-form";
import { MonitorTable } from "@/components/admin/monitor-table";
import {
  IncidentForm,
  MaintenanceForm,
  type IncidentBody,
  type MaintenanceBody,
} from "@/components/admin/post-forms";
import { QuotaCard } from "@/components/admin/quota-card";
import { SettingsForm } from "@/components/admin/settings-form";
import { DONE_MS, type PendingState } from "@/components/pending";
import { Mascot, PoweredBy } from "@/components/powered-by";
import { Segmented } from "@/components/segmented";
import { RowMenu } from "@/components/row-menu";
import { LiveBadge } from "@/components/status/live-badge";
import { Switch } from "@/components/switch";
import { SvgDefs } from "@/components/svg-defs";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, relativeTime } from "@/lib/format";
import { patchBar, patchMonitors, useLive, type BarSample } from "@/lib/live";
import { useShake } from "@/lib/shake";

interface Session {
  setup_required: boolean;
  authenticated: boolean;
  username: string | null;
}

interface Panel {
  monitors: AdminMonitor[];
  groups: MonitorGroup[];
  incidents: Incident[];
  maintenance: MaintenanceWindow[];
  channels: NotificationChannel[];
  settings: Settings;
  quota: QuotaEstimate;
}

type OpenForm =
  | { kind: "monitor"; monitor: AdminMonitor | null }
  | { kind: "incident"; incident: Incident | null }
  | { kind: "window"; window: MaintenanceWindow | null }
  | { kind: "channel"; channel: NotificationChannel | null }
  | null;

const TABS = {
  monitors: "Monitors",
  posts: "Incidents",
  channels: "Notifications",
  settings: "Settings",
} as const;

type Tab = keyof typeof TABS;

/** Exported for the render test: the nav's labels are part of the contract. */
export const TAB_OPTIONS = (Object.keys(TABS) as Tab[]).map((value) => ({
  value,
  label: TABS[value],
}));

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(problem(payload, response.status));
  return payload as T;
}

/** The API has one error shape, so this is the one place that reads it. */
function problem(payload: unknown, status: number): string {
  const body = payload as {
    error?: string;
    issues?: Array<{ path: string; message: string }>;
  } | null;

  const issue = body?.issues?.[0];
  if (issue) return `${issue.path}: ${issue.message}`;
  if (body?.error === "invalid_credentials") return "Wrong username or password.";
  if (body?.error === "locked") return "Too many failed attempts. Try again in fifteen minutes.";
  if (status === 401) return "That session has expired. Sign in again.";
  return body?.error ?? `Request failed (${status}).`;
}

/**
 * The admin panel. The only component that fetches: every child takes props and
 * returns markup, and every mutation is followed by one `load()` refetch rather
 * than an optimistic update — a monitoring tool must never show a monitor it
 * failed to save.
 */
export function AdminPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [tab, setTab] = useState<Tab>("monitors");
  const [open, setOpen] = useState<OpenForm>(null);
  const [error, setError] = useState<string | null>(null);
  // One mutation lane for the whole panel: the button that was pressed spins,
  // then draws its check. `busy` is derived rather than stored, because two
  // booleans for one request is how they end up disagreeing.
  const [pending, setPending] = useState<PendingState>("idle");
  const busy = pending === "busy";
  // Failed attempts. Only ever read as a shake trigger — a counter rather than
  // the message, so the same rejection twice shakes twice.
  const [attempt, setAttempt] = useState(0);
  /** The channel whose test message is in flight; it has no button of its own. */
  const [test, setTest] = useState<number | null>(null);
  const [openHeartbeats, setOpenHeartbeats] = useState<number | null>(null);
  const [heartbeats, setHeartbeats] = useState<BarSample[] | null>(null);
  // Bumped when the socket comes back: frames were missed while it was down, so
  // the open bar is refetched rather than continued from a gap.
  const [resume, setResume] = useState(0);

  const load = useCallback(async () => {
    const [monitors, groups, incidents, maintenance, channels, settings, quota] = await Promise.all([
      api<AdminMonitor[]>("/monitors"),
      api<MonitorGroup[]>("/groups"),
      api<Incident[]>("/incidents"),
      api<MaintenanceWindow[]>("/maintenance"),
      api<NotificationChannel[]>("/channels"),
      api<Settings>("/settings"),
      api<QuotaEstimate>("/quota"),
    ]);
    setPanel({ monitors, groups, incidents, maintenance, channels, settings, quota });
  }, []);

  useEffect(() => {
    api<Session>("/session")
      .then(async (next) => {
        setSession(next);
        if (next.authenticated) await load();
      })
      .catch((cause: Error) => setError(cause.message));
  }, [load]);

  // The API returns the newest check first and a bar reads oldest to newest, so
  // the one reversal happens here, where the fetch lands.
  useEffect(() => {
    if (openHeartbeats === null) return;
    let live = true;
    setHeartbeats(null);
    api<Heartbeat[]>(`/monitors/${openHeartbeats}/heartbeats`)
      .then((rows) => live && setHeartbeats(rows.reverse()))
      .catch((cause: Error) => live && setError(cause.message));
    return () => {
      live = false;
    };
  }, [openHeartbeats, resume]);

  /** One frame moves the rows and, if its monitor is open, the bar under it. */
  function applyLive(updates: LiveStatus[]): void {
    setPanel((current) =>
      current === null ? current : { ...current, monitors: patchMonitors(current.monitors, updates) },
    );
    setHeartbeats((current) =>
      current === null || openHeartbeats === null
        ? current
        : patchBar(current, openHeartbeats, updates),
    );
  }

  /**
   * Every mutation: run it, refetch, and report what broke. The form stays open
   * on success until the check has been seen — closing it the instant the request
   * lands is what makes a save feel like it might not have happened.
   */
  async function run(work: () => Promise<unknown>): Promise<void> {
    setPending("busy");
    setError(null);
    try {
      await work();
      await load();
      setPending("done");
    } catch (cause) {
      setError((cause as Error).message);
      setAttempt((count) => count + 1);
      setPending("idle");
      setTest(null);
    }
  }

  // The check's own lifetime, and the only thing that closes a form that saved.
  useEffect(() => {
    if (pending !== "done") return;
    const timer = globalThis.setTimeout(() => {
      setPending("idle");
      setOpen(null);
      setTest(null);
    }, DONE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [pending]);

  async function authenticate(path: "/setup" | "/login", credentials: Credentials): Promise<void> {
    setPending("busy");
    setError(null);
    try {
      const admin = await api<{ username: string }>(path, "POST", credentials);
      setSession({ setup_required: false, authenticated: true, username: admin.username });
      await load();
    } catch (cause) {
      setError((cause as Error).message);
      setAttempt((count) => count + 1);
    } finally {
      setPending("idle");
    }
  }

  async function signOut(): Promise<void> {
    await api("/logout", "POST").catch(() => undefined);
    setPanel(null);
    setSession({ setup_required: false, authenticated: false, username: null });
  }

  function remove(what: string, path: string): void {
    if (!globalThis.confirm(`Delete ${what}? This cannot be undone.`)) return;
    void run(() => api(path, "DELETE"));
  }

  if (session === null) {
    return (
      <Shell centred>
        <p className="text-muted-foreground glass mx-auto max-w-sm rounded-xl border p-6 text-sm">
          Checking session…
        </p>
        <Alert message={error} attempt={attempt} />
      </Shell>
    );
  }

  if (session.setup_required) {
    return (
      <Shell centred>
        <SetupForm
          onSubmit={(credentials) => void authenticate("/setup", credentials)}
          error={error}
          pending={pending}
          attempt={attempt}
        />
      </Shell>
    );
  }

  if (!session.authenticated) {
    return (
      <Shell centred>
        <LoginForm
          onSubmit={(credentials) => void authenticate("/login", credentials)}
          error={error}
          pending={pending}
          attempt={attempt}
        />
      </Shell>
    );
  }

  const now = Math.floor(Date.now() / 1_000);

  return (
    <Shell>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {panel?.settings.site_name ?? "FlarePulse"} admin
          </h1>
          <p className="text-muted-foreground text-sm">Signed in as {session.username}.</p>
        </div>
        <div className="flex items-center gap-2">
          <LiveIndicator
            onUpdates={applyLive}
            onResume={() => {
              setResume((count) => count + 1);
              void load().catch((cause: Error) => setError(cause.message));
            }}
          />
          <Button variant="outline" size="sm" asChild>
            <a href="/">View status page</a>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <Segmented
        options={TAB_OPTIONS}
        value={tab}
        label="Admin sections"
        onSelect={(key) => {
          setTab(key);
          setOpen(null);
        }}
      />

      <Alert message={error} attempt={attempt} />

      {panel === null ? (
        <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">Loading…</p>
      ) : (
        <>
          {tab === "monitors" && (
            <section className="space-y-4">
              <SectionHeader
                title="Monitors"
                hint="Checked from one Cloudflare-selected location, no faster than every 60 seconds."
                action={
                  <Button size="sm" onClick={() => setOpen({ kind: "monitor", monitor: null })}>
                    New monitor
                  </Button>
                }
              />

              {open?.kind === "monitor" && (
                <MonitorForm
                  monitor={open.monitor}
                  groups={panel.groups}
                  pending={pending}
                  onCancel={() => setOpen(null)}
                  onSubmit={(values: MonitorBody) =>
                    void run(() =>
                      open.monitor === null
                        ? api("/monitors", "POST", values)
                        : api(`/monitors/${open.monitor.id}`, "PATCH", values),
                    )
                  }
                />
              )}

              <MonitorTable
                monitors={panel.monitors}
                now={now}
                openMonitor={openHeartbeats}
                heartbeats={heartbeats}
                onToggle={(monitor) =>
                  setOpenHeartbeats((current) => (current === monitor.id ? null : monitor.id))
                }
                onEdit={(monitor) => setOpen({ kind: "monitor", monitor })}
                onDelete={(monitor) => remove(monitor.name, `/monitors/${monitor.id}`)}
              />

              <Groups groups={panel.groups} busy={busy} run={run} remove={remove} />
            </section>
          )}

          {tab === "posts" && (
            <section className="space-y-6">
              <div className="space-y-3">
                <SectionHeader
                  title="Incidents"
                  hint="Posted here, and opened automatically when a monitor goes down."
                  action={
                    <Button size="sm" onClick={() => setOpen({ kind: "incident", incident: null })}>
                      New incident
                    </Button>
                  }
                />

                {open?.kind === "incident" && (
                  <IncidentForm
                    incident={open.incident}
                    monitors={panel.monitors}
                    pending={pending}
                    onCancel={() => setOpen(null)}
                    onSubmit={(values: IncidentBody) =>
                      void run(() =>
                        open.incident === null
                          ? api("/incidents", "POST", values)
                          : api(`/incidents/${open.incident.id}`, "PATCH", values),
                      )
                    }
                  />
                )}

                <Rows
                  empty="No incidents posted."
                  items={panel.incidents.map((incident) => ({
                    id: incident.id,
                    title: incident.title,
                    detail: `${incident.status} · started ${relativeTime(incident.started_at, now)}`,
                    onEdit: () => setOpen({ kind: "incident", incident }),
                    onDelete: () => remove(incident.title, `/incidents/${incident.id}`),
                  }))}
                />
              </div>

              <div className="space-y-3">
                <SectionHeader
                  title="Maintenance"
                  hint="A scheduled window shows as a banner on the status page while it is open."
                  action={
                    <Button size="sm" onClick={() => setOpen({ kind: "window", window: null })}>
                      Schedule window
                    </Button>
                  }
                />

                {open?.kind === "window" && (
                  <MaintenanceForm
                    window={open.window}
                    pending={pending}
                    onCancel={() => setOpen(null)}
                    onSubmit={(values: MaintenanceBody) =>
                      void run(() =>
                        open.window === null
                          ? api("/maintenance", "POST", values)
                          : api(`/maintenance/${open.window.id}`, "PATCH", values),
                      )
                    }
                  />
                )}

                <Rows
                  empty="No maintenance scheduled."
                  items={panel.maintenance.map((window) => ({
                    id: window.id,
                    title: window.title,
                    detail: `${formatDateTime(window.starts_at)} → ${formatDateTime(window.ends_at)}`,
                    onEdit: () => setOpen({ kind: "window", window }),
                    onDelete: () => remove(window.title, `/maintenance/${window.id}`),
                  }))}
                />
              </div>
            </section>
          )}

          {tab === "channels" && (
            <section className="space-y-4">
              <SectionHeader
                title="Notifications"
                hint="One message per channel when a monitor changes state, never one per failed check."
                action={
                  <Button size="sm" onClick={() => setOpen({ kind: "channel", channel: null })}>
                    New channel
                  </Button>
                }
              />

              {open?.kind === "channel" && (
                <ChannelForm
                  channel={open.channel}
                  pending={pending}
                  onCancel={() => setOpen(null)}
                  onSubmit={(values: ChannelBody) =>
                    void run(() =>
                      open.channel === null
                        ? api("/channels", "POST", values)
                        : api(`/channels/${open.channel.id}`, "PATCH", values),
                    )
                  }
                />
              )}

              <ChannelList
                channels={panel.channels}
                now={now}
                busy={busy}
                test={test === null ? null : { id: test, state: pending }}
                onTest={(channel) => {
                  setTest(channel.id);
                  void run(() => api(`/channels/${channel.id}/test`, "POST"));
                }}
                onEdit={(channel) => setOpen({ kind: "channel", channel })}
                onDelete={(channel) => remove(channel.name, `/channels/${channel.id}`)}
              />
            </section>
          )}

          {tab === "settings" && (
            <section className="space-y-4">
              <SectionHeader
                title="Settings"
                hint="Branding and what FlarePulse does on its own when a monitor changes state."
              />
              <SettingsForm
                settings={panel.settings}
                pending={pending}
                onSubmit={(values) => void run(() => api("/settings", "PATCH", values))}
              />
              <QuotaCard quota={panel.quota} />
            </section>
          )}
        </>
      )}
    </Shell>
  );
}

/**
 * `centred` is for the signed-out screens: one small card on an otherwise empty
 * page belongs in the middle of the viewport, not pinned to the top of it. The
 * panel itself is taller than the viewport, so it stays where it is.
 *
 * The flex classes go on this container rather than on a wrapper around it. A
 * wrapper would make this div a flex item, and `mx-auto` on a flex item cancels
 * the cross-axis stretch — the container would shrink to fit its contents, and a
 * card sized `w-full` inside it collapses with it.
 */
function Shell({ children, centred = false }: { children: React.ReactNode; centred?: boolean }) {
  return (
    <div
      className={`mx-auto max-w-4xl space-y-6 p-4 sm:py-10 ${
        centred ? "flex min-h-svh flex-col justify-center" : ""
      }`}
    >
      {centred && <Mascot />}
      {children}
      <footer className={centred ? undefined : "border-t pt-6"}>
        <PoweredBy mark={!centred} />
      </footer>
      {/* Last, not first: `space-y-6` margins every child after the first, and a
          zero-sized filter host must not push the panel down. */}
      <SvgDefs />
    </div>
  );
}

/**
 * Its own component so it mounts only once signed in: opening the socket from
 * the login screen would earn a 401 and then reconnect forever.
 */
function LiveIndicator(handlers: {
  onUpdates: (updates: LiveStatus[]) => void;
  onResume: () => void;
}) {
  const state = useLive("/api/admin/live", handlers);

  return <LiveBadge state={state} />;
}

/**
 * A failed mutation. `.t-input` carries recipe 12's shake; the border colour comes
 * with `.is-error` from the same rule rather than from a Tailwind utility, which
 * unlayered CSS would outrank anyway.
 */
function Alert({ message, attempt }: { message: string | null; attempt: number }) {
  const alert = useShake<HTMLParagraphElement>(attempt);

  return message === null ? null : (
    <p
      ref={alert}
      role="alert"
      className="t-input is-error text-destructive rounded-md border p-3 text-sm"
    >
      {message}
    </p>
  );
}

/**
 * Every tab opens the same way: a title, one line of context, and the action that
 * makes a new one — recipe 18's reveal, replayed on each tab switch because the
 * tabs unmount each other. The status page's hero uses the same three classes.
 */
function SectionHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setShown(true);
  }, []);

  return (
    <div
      className={`t-stagger flex flex-wrap items-end justify-between gap-3 ${
        shown ? "is-shown" : ""
      }`}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="t-stagger-line text-lg font-semibold tracking-tight">{title}</h2>
        {hint === undefined ? null : (
          <p className="text-muted-foreground t-stagger-line t-stagger-line--2 text-sm">{hint}</p>
        )}
      </div>
      {action}
    </div>
  );
}

interface Row {
  id: number;
  title: string;
  detail: string;
  onEdit: () => void;
  onDelete: () => void;
}

/** Incidents and maintenance windows list the same way, so they share one list. */
function Rows({ items, empty }: { items: Row[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">{empty}</p>;
  }

  return (
    <ul className="glass glass-popover divide-y rounded-xl border">
      {items.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-48 flex-1">
            <p className="font-medium">{row.title}</p>
            <p className="text-muted-foreground text-xs">{row.detail}</p>
          </div>
          <RowMenu
            label={`Actions for ${row.title}`}
            actions={[
              { label: "Edit", onSelect: row.onEdit },
              { label: "Delete", onSelect: row.onDelete, destructive: true },
            ]}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Groups are a name and a visibility flag, so they get one input rather than a
 * form component. A group with `is_public` off hides its monitors from the
 * public page; ungrouped monitors are public.
 */
function Groups({
  groups,
  busy,
  run,
  remove,
}: {
  groups: MonitorGroup[];
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  remove: (what: string, path: string) => void;
}) {
  return (
    <div className="glass glass-popover space-y-3 rounded-xl border p-4">
      <h3 className="font-semibold tracking-tight">Groups</h3>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const name = String(new FormData(form).get("name") ?? "").trim();
          if (name === "") return;
          void run(() => api("/groups", "POST", { name })).then(() => form.reset());
        }}
      >
        {/* No visible label: the field's whole job is written in it. The name
            comes from `aria-label`, since a placeholder is a hint and not a
            label — it disappears the moment someone types. */}
        <Input
          id="group-name"
          name="name"
          maxLength={64}
          placeholder="Add new group"
          aria-label="Add new group"
          className="sm:w-64"
        />
        <Button type="submit" size="sm" disabled={busy}>
          Add group
        </Button>
      </form>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No groups yet. Ungrouped monitors appear on the public page under “Services”.
        </p>
      ) : (
        <ul className="divide-y">
          {groups.map((group) => (
            <li key={group.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="min-w-32 flex-1 text-sm font-medium">{group.name}</span>
              {/* The state word gets a fixed slot, or every row's toggle and menu
                  sit at whatever x "Public" and "Hidden" happen to end at — the
                  two are states of one control and have to line up down the
                  list. */}
              <Switch
                id={`group-public-${group.id}`}
                checked={group.is_public === 1}
                disabled={busy}
                label={
                  <span className="inline-block w-14">
                    {group.is_public === 1 ? "Public" : "Hidden"}
                  </span>
                }
                onChange={() =>
                  void run(() =>
                    api(`/groups/${group.id}`, "PATCH", { is_public: group.is_public !== 1 }),
                  )
                }
              />
              <RowMenu
                label={`Actions for ${group.name}`}
                actions={[
                  {
                    label: "Delete",
                    onSelect: () => remove(group.name, `/groups/${group.id}`),
                    destructive: true,
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
