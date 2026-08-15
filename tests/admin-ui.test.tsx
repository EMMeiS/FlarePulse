import type { ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AdminMonitor,
  Incident,
  MaintenanceWindow,
  MonitorGroup,
  NotificationChannel,
  Settings,
} from "../src/db";
import type { QuotaEstimate } from "../src/admin";
import type { BarSample } from "@/lib/live";
import { LoginForm, SetupForm } from "../frontend/components/admin/auth-forms";
import { ChannelForm } from "../frontend/components/admin/channel-form";
import { ChannelList } from "../frontend/components/admin/channel-list";
import { MonitorForm } from "../frontend/components/admin/monitor-form";
import { MonitorTable } from "../frontend/components/admin/monitor-table";
import { IncidentForm, MaintenanceForm } from "../frontend/components/admin/post-forms";
import { QuotaCard } from "../frontend/components/admin/quota-card";
import { SettingsForm } from "../frontend/components/admin/settings-form";
import { Segmented } from "../frontend/components/segmented";
import { AdminPage, TAB_OPTIONS } from "../frontend/AdminPage";

// Render tests only: markup, not a painted browser.
const NOW = 1_700_000_000;

const monitor: AdminMonitor = {
  id: 3,
  name: "api.example.com",
  type: "http",
  target: "https://api.example.com/health",
  interval_seconds: 120,
  timeout_ms: 5_000,
  retries: 1,
  expected_status: 204,
  keyword: "ok",
  keyword_invert: 0,
  group_id: 7,
  enabled: 1,
  status: "up",
  last_checked_at: NOW - 30,
  next_check_at: NOW + 90,
  fail_streak: 0,
  created_at: NOW - 86_400,
  group_name: "Core",
};

const groups: MonitorGroup[] = [{ id: 7, name: "Core", position: 0, is_public: 1 }];

const noop = () => {};

/** The table gained live props, so every render goes through one set of defaults. */
function table(overrides: Partial<ComponentProps<typeof MonitorTable>> = {}): string {
  return renderToString(
    <MonitorTable
      monitors={[monitor]}
      now={NOW}
      openMonitor={null}
      heartbeats={null}
      onToggle={noop}
      onEdit={noop}
      onDelete={noop}
      {...overrides}
    />,
  );
}

describe("the auth forms", () => {
  it("says the setup screen happens once and states the password minimum", () => {
    const html = renderToString(
      <SetupForm onSubmit={noop} error={null} pending="idle" attempt={0} />,
    );

    expect(html).toContain("Create the admin account");
    expect(html).toContain("only account");
    expect(html).toContain("At least 12 characters");
    expect(html).toContain('for="setup-username"');
    expect(html).toContain('for="setup-password"');
    expect(html).toContain('id="setup-password"');
  });

  it("shows a login error in a live region and never echoes the password", () => {
    const html = renderToString(
      <LoginForm
        onSubmit={noop}
        error="Wrong username or password."
        pending="idle"
        attempt={1}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Wrong username or password.");
    expect(html).toContain('type="password"');
    expect(html).toContain('for="login-username"');
    // The card is as tall as the form and no taller. It was briefly a 1:1 box; the
    // empty band that left under the button was the browser verdict against it.
    expect(html).not.toContain("aspect-square");
  });

  it("disables the button while a request is in flight", () => {
    expect(
      renderToString(<LoginForm onSubmit={noop} error={null} pending="busy" attempt={0} />),
    ).toContain("disabled");
  });

  it("puts a spinner in the button that was pressed, and nothing there at rest", () => {
    const busy = renderToString(
      <LoginForm onSubmit={noop} error={null} pending="busy" attempt={0} />,
    );
    const idle = renderToString(
      <LoginForm onSubmit={noop} error={null} pending="idle" attempt={0} />,
    );

    // Recipe 09's exchange slot, showing its spinner half.
    expect(busy).toContain('class="t-icon-swap size-4 shrink-0" data-state="b"');
    expect(busy).toContain("t-spin");
    expect(busy).toContain("Signing in…");
    // A button at rest is the button it always was: no slot, no spinner, no check.
    expect(idle).not.toContain("t-icon-swap");
    expect(idle).not.toContain("t-spin");
  });
});

describe("the monitor form", () => {
  it("states the 60-second floor and the single vantage point next to the fields", () => {
    const html = renderToString(
      <MonitorForm
        monitor={null}
        groups={groups}
        onSubmit={noop}
        onCancel={noop}
        pending="idle"
      />,
    );

    expect(html).toContain("60 seconds");
    expect(html).toContain("one Cloudflare-selected location");
    expect(html).toContain("no ping monitor");
  });

  it("offers the three real types and defaults a new monitor", () => {
    const html = renderToString(
      <MonitorForm
        monitor={null}
        groups={groups}
        onSubmit={noop}
        onCancel={noop}
        pending="idle"
      />,
    );

    expect(html).toContain("Add monitor");
    for (const type of ["HTTP(S)", "TCP", "DNS"]) expect(html).toContain(type);
    expect(html).toContain('value="60"');
    expect(html).toContain('value="10000"');
  });

  it("prefills every field when editing", () => {
    const html = renderToString(
      <MonitorForm
        monitor={monitor}
        groups={groups}
        onSubmit={noop}
        onCancel={noop}
        pending="idle"
      />,
    );

    expect(html).toContain("Save monitor");
    expect(html).toContain("https://api.example.com/health");
    expect(html).toContain('value="120"');
    expect(html).toContain('value="5000"');
    expect(html).toContain('value="204"');
    expect(html).toContain('value="ok"');
    expect(html).toContain("Core");
  });
});

describe("the monitor table", () => {
  it("shows the target and the schedule the public page hides", () => {
    const html = table();

    expect(html).toContain("api.example.com");
    expect(html).toContain("https://api.example.com/health");
    expect(html).toContain("every 120s");
    expect(html).toContain("Operational");
    expect(html).toContain("Core");
  });

  it("names the monitor its actions act on", () => {
    const html = table();

    expect(html).toContain("Actions for api.example.com");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Delete<");
  });

  it("leaves the row menu a shut disclosure that says what it opens", () => {
    const html = table();

    expect(html).toContain('aria-haspopup="true"');
    // The panel is in the DOM for its transition and shut by `visibility`, which
    // is what keeps its buttons out of the tab order — so no open class here.
    expect(html).toContain('data-origin="top-right"');
    expect(html).not.toContain("is-open");
    // Two disclosures per row, the heartbeats panel and the menu, both closed.
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    // And the list surface opts out of clipping, or the panel is cut off at the
    // card edge on the last row.
    expect(html).toContain("glass glass-popover");
  });

  it("says the list is empty rather than rendering an empty table", () => {
    expect(table({ monitors: [] })).toContain("No monitors yet.");
  });

  it("marks a disabled monitor as paused", () => {
    expect(table({ monitors: [{ ...monitor, enabled: 0 }] })).toContain("Paused");
  });
});

describe("the live heartbeat view", () => {
  const bar: BarSample[] = [
    { checked_at: NOW - 120, status: "up", latency_ms: 40, message: "200" },
    { checked_at: NOW - 60, status: "down", latency_ms: null, message: "HTTP 500" },
  ];

  it("offers a toggle per monitor, named and wired to its own panel", () => {
    const html = table();

    expect(html).toContain("Heartbeats for api.example.com");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="monitor-3-heartbeats"');
    // The panel stays mounted so its height can animate, and is hidden from
    // assistive tech while closed rather than read as content nobody opened.
    expect(html).toContain('class="t-acc-panel" aria-hidden="true"');
    expect(html).toContain('data-open="false"');
  });

  it("waits for the checks instead of drawing an empty bar", () => {
    const html = table({ openMonitor: 3, heartbeats: null });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Loading heartbeats…");
  });

  it("draws the bar and the newest check's message once they arrive", () => {
    const html = table({ openMonitor: 3, heartbeats: bar });

    expect(html).toContain('aria-label="Last 2 checks for api.example.com"');
    expect(html).toContain("bg-down");
    // Newest last, so the message shown is the failing check's, not the 200.
    expect(html).toContain("HTTP 500");
  });

  it("says the monitor has never been checked rather than drawing nothing", () => {
    expect(table({ openMonitor: 3, heartbeats: [] })).toContain("No checks recorded yet.");
  });
});

describe("the quota card", () => {
  const quota: QuotaEstimate = {
    monitors: 10,
    checks_per_minute: 10,
    subrequest_limit: 50,
    heartbeat_writes_per_day: 14_400,
    rollup_writes_per_day: 250,
    writes_per_day: 14_650,
    write_limit: 100_000,
    percent_used: 14.7,
    monitors_at_this_rate: 58,
  };

  it("shows the arithmetic and refuses to call it a bill", () => {
    const html = renderToString(<QuotaCard quota={quota} />);

    expect(html).toContain("14,650");
    expect(html).toContain("100,000");
    expect(html).toContain("14.7%");
    expect(html).toContain("58 more");
    expect(html).toContain("10 / 50");
    expect(html).toContain("estimate");
    expect(html).toContain("Cloudflare dashboard");
  });
});

describe("the incident and maintenance forms", () => {
  const incident: Incident = {
    id: 4,
    monitor_id: 3,
    title: "Elevated errors",
    body: "Investigating.",
    status: "identified",
    started_at: NOW - 600,
    resolved_at: null,
    auto: 0,
  };

  it("offers the four statuses and prefills an edit", () => {
    const html = renderToString(
      <IncidentForm
        incident={incident}
        monitors={[monitor]}
        onSubmit={noop}
        onCancel={noop}
        pending="idle"
      />,
    );

    for (const label of ["Investigating", "Identified", "Monitoring", "Resolved"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Elevated errors");
    expect(html).toContain("Investigating.");
    expect(html).toContain("Whole platform");
  });

  it("takes the two ends of a maintenance window as local datetimes", () => {
    const window: MaintenanceWindow = {
      id: 1,
      title: "Database upgrade",
      body: null,
      starts_at: NOW,
      ends_at: NOW + 3_600,
    };

    const html = renderToString(
      <MaintenanceForm window={window} onSubmit={noop} onCancel={noop} pending="idle" />,
    );

    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Database upgrade");
    expect(html).toContain('for="maintenance-starts"');
    expect(html).toContain('for="maintenance-ends"');
  });
});

describe("the settings form", () => {
  const settings: Settings = {
    id: 1,
    site_name: "Acme Status",
    auto_open_incidents: 1,
    auto_resolve_incidents: 1,
    updated_at: NOW,
  };

  it("prefills the name the public page shows", () => {
    const html = renderToString(
      <SettingsForm settings={settings} onSubmit={noop} pending="idle" />,
    );

    expect(html).toContain('value="Acme Status"');
    expect(html).toContain('for="settings-site-name"');
  });

  it("sets the name inside its own field, with the label as that field's caption", () => {
    const html = renderToString(
      <SettingsForm settings={settings} onSubmit={noop} pending="idle" />,
    );

    // Caption then value inside one box, Apple-style: the box owns the border
    // and the focus ring, the input inside it owns neither. It stays a real
    // label — a placeholder would vanish as soon as anyone typed.
    expect(html).toMatch(/<label[^>]*for="settings-site-name"[^>]*>Site name<\/label><input/);
    expect(html).toContain("focus-within:ring-[3px]");
    expect(html).toContain("Up to 32 characters.");
  });

  it("renders both incident policies as labelled checkboxes", () => {
    const html = renderToString(
      <SettingsForm settings={settings} onSubmit={noop} pending="idle" />,
    );

    expect(html).toContain('for="settings-auto-open"');
    expect(html).toContain('for="settings-auto-resolve"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    // Both toggles default on, so both boxes are checked.
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });

  it("reflects a toggle that is off", () => {
    const html = renderToString(
      <SettingsForm
        settings={{ ...settings, auto_resolve_incidents: 0 }}
        onSubmit={noop}
        pending="idle"
      />,
    );

    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("keeps each toggle a real checkbox with its own form name", () => {
    const html = renderToString(
      <SettingsForm settings={settings} onSubmit={noop} pending="idle" />,
    );

    // Recipe 27 styles the input itself, so the browser still owns the state:
    // `name` and `defaultChecked` are what the submit handler reads.
    expect(html.match(/class="t-toggle/g)).toHaveLength(2);
    expect(html).toContain('name="auto_open_incidents"');
    expect(html).toContain('name="auto_resolve_incidents"');
  });
});

describe("the channel form", () => {
  const telegram: NotificationChannel = {
    id: 2,
    type: "telegram",
    name: "On-call chat",
    url: null,
    bot_token: "123456:ABC-DEF",
    chat_id: "-1001",
    enabled: 1,
    last_sent_at: null,
    last_error: null,
    created_at: NOW - 3_600,
  };

  it("offers the three channel types and asks a webhook only for its URL", () => {
    const html = renderToString(
      <ChannelForm channel={null} onSubmit={noop} onCancel={noop} pending="idle" />,
    );

    expect(html).toContain("Add channel");
    for (const label of ["Webhook", "Discord", "Telegram"]) expect(html).toContain(label);
    expect(html).toContain('for="channel-name"');
    expect(html).toContain('for="channel-url"');
    expect(html).not.toContain('for="channel-token"');
    expect(html).not.toContain('for="channel-chat"');
  });

  it("asks a telegram channel for the token and the chat id, and prefills an edit", () => {
    const html = renderToString(
      <ChannelForm channel={telegram} onSubmit={noop} onCancel={noop} pending="idle" />,
    );

    expect(html).toContain("Save channel");
    expect(html).toContain('value="On-call chat"');
    expect(html).toContain('for="channel-token"');
    expect(html).toContain('for="channel-chat"');
    expect(html).toContain('value="123456:ABC-DEF"');
    expect(html).toContain('value="-1001"');
    expect(html).not.toContain('for="channel-url"');
  });
});

describe("the channel list", () => {
  const webhook: NotificationChannel = {
    id: 1,
    type: "webhook",
    name: "Ops webhook",
    url: "https://hooks.example.com/flarepulse",
    bot_token: null,
    chat_id: null,
    enabled: 1,
    last_sent_at: NOW - 120,
    last_error: null,
    created_at: NOW - 86_400,
  };

  it("reports each channel's type, state and last delivery", () => {
    const html = renderToString(
      <ChannelList
        channels={[
          webhook,
          { ...webhook, id: 2, name: "Broken hook", last_error: "HTTP 404" },
          { ...webhook, id: 3, name: "Fresh hook", enabled: 0, last_sent_at: null },
        ]}
        now={NOW}
        busy={false}
        test={null}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(html).toContain("Ops webhook");
    expect(html).toContain("Webhook");
    expect(html).toContain("2 min ago");
    expect(html).toContain("HTTP 404");
    expect(html).toContain("Disabled");
    expect(html).toContain("never");
  });

  it("names the channel every control acts on", () => {
    const html = renderToString(
      <ChannelList
        channels={[webhook]}
        now={NOW}
        busy={false}
        test={null}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(html).toContain("Actions for Ops webhook");
    expect(html).toContain("Send test message");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Delete<");
  });

  it("opts the list surface out of clipping, so the last row's menu is not cut off", () => {
    const html = renderToString(
      <ChannelList
        channels={[webhook]}
        now={NOW}
        busy={false}
        test={null}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    // `.glass` hides its own overflow and contains paint. A list that hosts a
    // RowMenu has to say so, or the panel is clipped at the card edge.
    expect(html).toContain("glass glass-popover");
  });

  it("says what an empty list means", () => {
    const html = renderToString(
      <ChannelList
        channels={[]}
        now={NOW}
        busy={false}
        test={null}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(html).toContain("No channels yet");
    expect(html).toContain("Nothing is sent");
  });

  it("reports a sent test on the row it was sent from, and on no other", () => {
    const html = renderToString(
      <ChannelList
        channels={[webhook, { ...webhook, id: 2, name: "Broken hook" }]}
        now={NOW}
        busy={false}
        test={{ id: 1, state: "done" }}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    // One slot for two rows, showing the check half — the test lives in a menu,
    // so the row is the only thing that can report on it.
    expect(html.match(/class="t-icon-swap/g)).toHaveLength(1);
    expect(html).toContain('data-state="c"');
    expect(html).toContain('class="t-icon t-success-check" data-icon="c" data-state="in"');
  });
});

describe("the admin nav", () => {
  it("names its four sections and marks exactly one as current", () => {
    const html = renderToString(
      <Segmented options={TAB_OPTIONS} value="monitors" label="Admin sections" onSelect={noop} />,
    );

    for (const label of ["Monitors", "Incidents", "Notifications", "Settings"]) {
      expect(html).toContain(label);
    }
    expect(html.match(/class="t-tab /g)).toHaveLength(4);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // The same sliding pill the status page's window switcher uses, in the same
    // gooey layer — one control, not a second implementation.
    expect(html).toContain("t-tabs-pill");
    expect(html).toContain("t-tabs-ghost");
    expect(html).toContain('role="group" aria-label="Admin sections"');
  });
});

describe("the admin page shell", () => {
  it("waits for the session probe instead of guessing which screen to show", () => {
    // Effects do not run on the server, so this is the pre-fetch render.
    const html = renderToString(<AdminPage />);

    expect(html).toContain("Checking session…");
    // A signed-out screen is one small card: centred in the viewport, not pinned
    // to the top of it. The centring classes have to sit on the same element as
    // the width, not on a wrapper: `mx-auto` on a flex item cancels the stretch,
    // and the card inside would shrink to fit along with its parent.
    expect(html).toContain("max-w-4xl space-y-6 p-4 sm:py-10 flex min-h-svh flex-col justify-center");
  });

  it("signs the footer with the wordmark, and draws the mark once", () => {
    const html = renderToString(<AdminPage />);

    expect(html).toContain("Powered by");
    expect(html).toContain("FlarePulse");
    expect(html).toContain("items-center");
    // A signed-out screen wears the mark above the card, so the footer under it
    // is the wordmark alone: one page, one mascot. Counting `<img>` rather than
    // the path: React also emits a preload link for the same file.
    expect(html.match(/<img[^>]*flarepulse-mascot/g)).toHaveLength(1);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("Powered by"));
  });
});
