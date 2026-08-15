import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Incident, MaintenanceWindow } from "../src/db";
import type { MonitorHistory, StatusMonitor, StatusPayload } from "../src/status";
import { Hero } from "../frontend/components/status/hero";
import { IncidentTimeline, MaintenanceBanner } from "../frontend/components/status/incidents";
import { LatencyChart } from "../frontend/components/status/latency-chart";
import { LiveBadge } from "../frontend/components/status/live-badge";
import { MonitorCard, StatusBar } from "../frontend/components/status/monitor-card";
import { ThemeToggle } from "../frontend/components/theme-toggle";
import { StatusPage } from "../frontend/StatusPage";

// Render tests only: these check that the components say the right
// things, not that a browser paints them.
const NOW = 1_700_000_000;

const monitor: StatusMonitor = {
  id: 1,
  name: "api.example.com",
  type: "http",
  status: "up",
  last_checked_at: NOW - 30,
  latency_ms: 20,
  uptime: 99.95,
  heartbeats: [
    { checked_at: NOW - 120, status: "up", latency_ms: 18 },
    { checked_at: NOW - 60, status: "down", latency_ms: null },
    { checked_at: NOW - 30, status: "up", latency_ms: 20 },
  ],
};

const payload: StatusPayload = {
  name: "FlarePulse",
  generated_at: NOW,
  window: "24h",
  overall: "partial",
  monitors_up: 1,
  monitors_total: 2,
  groups: [{ id: 7, name: "Core", monitors: [monitor] }],
  maintenance: [],
  incidents: [],
};

const history: MonitorHistory = {
  monitor: { id: 1, name: "api.example.com", type: "http", status: "up", last_checked_at: NOW },
  window: "24h",
  bucket_size: 3_600,
  uptime: 99.95,
  points: [
    { start: NOW - 7_200, up: 60, down: 0, uptime: 100, latency_p50: 20, latency_p95: 44 },
    { start: NOW - 3_600, up: 30, down: 30, uptime: 50, latency_p50: 30, latency_p95: 90 },
  ],
};

describe("the hero", () => {
  it("leads with the sentence a visitor came for", () => {
    const html = renderToString(<Hero payload={payload} now={NOW} onWindow={() => {}} />);

    expect(html).toContain("Some systems are down");
    expect(html).toContain("1 of 2 monitors operational");
    expect(html).toContain("checked every 60 seconds");
    expect(html).toContain("Updated just now");
  });

  it("offers all four windows and marks the active one", () => {
    const html = renderToString(<Hero payload={payload} now={NOW} onWindow={() => {}} />);

    for (const label of ["24 hours", "7 days", "30 days", "90 days"]) {
      expect(html).toContain(label);
    }
    // Four plain buttons and one pill that slides between them; the 24h button
    // is the pressed one, and exactly one is.
    expect(html.match(/class="t-tab /g)).toHaveLength(4);
    expect(html).toContain("t-tabs-pill");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("is the strongest glass surface on the page, and answers the pointer with nothing", () => {
    const html = renderToString(<Hero payload={payload} now={NOW} onWindow={() => {}} />);

    expect(html).toContain("glass glass-hero");
    // The glare layer is deliberately absent: the hero is
    // something to read, so nothing on it follows the cursor.
    expect(html).not.toContain("t-tilt-glare");
    // The count is a value a check can change, so it re-enters when it does.
    expect(html).toContain('class="t-pop">1 of 2 monitors operational');
  });

  it("keeps the orb decoration: hidden from assistive tech, tinted by the status", () => {
    const html = renderToString(<Hero payload={payload} now={NOW} onWindow={() => {}} />);

    // A canvas that says nothing, in the tone of the headline beside it — which
    // is the thing that actually reports the status.
    expect(html).toContain('aria-hidden="true" class="text-degraded hidden shrink-0 sm:block"');
    expect(html).toContain("<canvas");
    expect(
      renderToString(
        <Hero payload={{ ...payload, overall: "up" }} now={NOW} onWindow={() => {}} />,
      ),
    ).toContain('class="text-up hidden shrink-0 sm:block"');
  });
});

describe("a monitor card", () => {
  it("shows the name, status and numbers without ever showing the target", () => {
    const html = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain("api.example.com");
    expect(html).toContain("Operational");
    expect(html).toContain("99.95%");
    expect(html).toContain("20 ms");
    expect(html).toContain("checked just now");
    // The payload carries no target, so the card cannot leak one.
    expect(html).not.toContain("https://");
  });

  it("renders one heartbeat segment per check, coloured by result", () => {
    const html = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Last 3 checks for api.example.com"');
    // One stadium segment per check, in the bar's own brighter tone set — not the
    // `bg-up` the status dot wears, which is why both counts are asserted.
    expect(html.match(/t-bar-seg/g)).toHaveLength(3);
    expect(html.match(/bg-up-bar/g)).toHaveLength(2);
    expect(html.match(/bg-down-bar/g)).toHaveLength(1);
    expect(html).toContain('role="img"');
    // The dot is the one thing still wearing the flat tone.
    expect(html.match(/class="size-2\.5 shrink-0 rounded-full bg-up/g)).toHaveLength(1);
  });

  it("waits for the series instead of drawing an empty chart", () => {
    const html = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={true}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain("Loading response times…");
    expect(html).toContain('data-text="Loading response times…"');
    expect(html).not.toContain("peak ");
    expect(html).not.toContain("Uptime per bucket");
  });

  it("keeps the response-time panel mounted, and hidden while it is collapsed", () => {
    const collapsed = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    const open = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={true}
        onToggle={() => {}}
      />,
    );

    // The panel is always in the DOM so its height can animate; `data-open`
    // drives the animation and `aria-hidden` keeps a closed panel out of the
    // accessibility tree.
    expect(collapsed).toContain('data-open="false"');
    expect(collapsed).toContain('class="t-acc-panel" aria-hidden="true"');
    expect(open).toContain('data-open="true"');
    expect(open).toContain('class="t-acc-panel" aria-hidden="false"');
  });

  it("is a glass surface, and re-enters the numbers a check changed", () => {
    const html = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="24h"
        history={null}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain('class="glass t-acc');
    expect(html).toContain('class="t-pop">Operational');
    expect(html).toContain('class="t-pop">20 ms');
    // The uptime rolls rather than pops, and says itself once for a screen
    // reader: the columns are ten copies of every digit.
    expect(html).toContain('class="sr-only">99.95%');
    expect(html).toContain('class="t-reel"');
    // A monitor with checks behind it has something to pulse about.
    expect(html).toContain("t-live-dot");
    expect(html.match(/t-bar-seg/g)).toHaveLength(3);
    expect(
      renderToString(
        <MonitorCard
          monitor={{ ...monitor, status: "pending" }}
          now={NOW}
          window="24h"
          history={null}
          expanded={false}
          onToggle={() => {}}
        />,
      ),
    ).not.toContain("t-live-dot");
  });

  it("draws the chart and the per-bucket uptime once the series arrives", () => {
    const html = renderToString(
      <MonitorCard
        monitor={monitor}
        now={NOW}
        window="7d"
        history={history}
        expanded={true}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain("<svg");
    expect(html).toContain("peak 90 ms");
    expect(html).toContain("Uptime per bucket for api.example.com over 7 days");
    // The 50% bucket is neither up nor down.
    expect(html).toContain("bg-degraded");
  });
});

describe("the charts", () => {
  it("says there is no data rather than drawing a flat line", () => {
    expect(renderToString(<LatencyChart points={[]} />)).toContain(
      "No response times recorded yet.",
    );
    expect(
      renderToString(
        <LatencyChart
          points={[{ start: NOW, up: 0, down: 5, uptime: 0, latency_p50: null, latency_p95: null }]}
        />,
      ),
    ).toContain("No response times recorded yet.");
  });

  it("breaks the line across a bucket with no successful check", () => {
    const gapped: MonitorHistory["points"] = [
      { start: NOW - 7_200, up: 60, down: 0, uptime: 100, latency_p50: 20, latency_p95: 30 },
      { start: NOW - 5_400, up: 30, down: 0, uptime: 100, latency_p50: 22, latency_p95: 33 },
      { start: NOW - 3_600, up: 0, down: 60, uptime: 0, latency_p50: null, latency_p95: null },
      { start: NOW - 1_800, up: 60, down: 0, uptime: 100, latency_p50: 25, latency_p95: 40 },
      { start: NOW, up: 60, down: 0, uptime: 100, latency_p50: 26, latency_p95: 41 },
    ];

    const html = renderToString(<LatencyChart points={gapped} />);

    // Two runs per series rather than one line drawn through the outage.
    expect(html.match(/class="stroke-primary"/g)).toHaveLength(2);
  });

  it("says so when a monitor has never been checked", () => {
    expect(renderToString(<StatusBar segments={[]} label="none" />)).toContain(
      "No checks recorded yet.",
    );
  });
});

describe("maintenance and incidents", () => {
  const window: MaintenanceWindow = {
    id: 1,
    title: "Database upgrade",
    body: "Read-only for about ten minutes.",
    starts_at: NOW - 600,
    ends_at: NOW + 600,
  };

  it("renders nothing when there is no maintenance", () => {
    expect(renderToString(<MaintenanceBanner maintenance={[]} now={NOW} />)).toBe("");
  });

  it("distinguishes maintenance in progress from maintenance scheduled", () => {
    expect(renderToString(<MaintenanceBanner maintenance={[window]} now={NOW} />)).toContain(
      "Maintenance in progress",
    );
    expect(
      renderToString(
        <MaintenanceBanner maintenance={[{ ...window, starts_at: NOW + 60 }]} now={NOW} />,
      ),
    ).toContain("Scheduled maintenance");
  });

  it("shows the incident timeline, ongoing and resolved", () => {
    const incidents: Incident[] = [
      {
        id: 2,
        monitor_id: 1,
        title: "Elevated errors",
        body: "Investigating a spike in 500s.",
        status: "investigating",
        started_at: NOW - 3_600,
        resolved_at: null,
        auto: 0,
      },
      {
        id: 1,
        monitor_id: 1,
        title: "Brief outage",
        body: null,
        status: "resolved",
        started_at: NOW - 86_400,
        resolved_at: NOW - 82_800,
        auto: 1,
      },
    ];

    const html = renderToString(<IncidentTimeline incidents={incidents} now={NOW} />);

    expect(html).toContain("Elevated errors");
    expect(html).toContain("ongoing");
    expect(html).toContain("Brief outage");
    expect(html).toContain("resolved 23 h ago");
  });

  it("says there were no incidents rather than showing an empty list", () => {
    expect(renderToString(<IncidentTimeline incidents={[]} now={NOW} />)).toContain(
      "No incidents reported.",
    );
  });
});

describe("the page shell", () => {
  it("states the three limitations on every render", () => {
    // Effects do not run on the server, so this is the pre-fetch render.
    const html = renderToString(<StatusPage />);

    expect(html).toContain("Loading status…");
    expect(html).toContain("one Cloudflare-selected location");
    expect(html).toContain("The shortest interval is 60 seconds");
    expect(html).toContain("no ping monitor");
    expect(html).toContain("Theme: system");
  });

  it("shimmers the copy that means 'working on it'", () => {
    const html = renderToString(<StatusPage />);

    // The ::before layer clips its gradient to a copy of the same string.
    expect(html).toContain('class="t-shimmer" data-text="Loading status…"');
    expect(html).toContain("glass");
  });

  it("says how the page keeps itself current", () => {
    expect(renderToString(<StatusPage />)).toContain("as each check completes");
  });

  it("signs the footer with the mark and the wordmark", () => {
    const html = renderToString(<StatusPage />);

    expect(html).toContain("Powered by");
    expect(html).toContain("FlarePulse");
    expect(html).toContain('src="/flarepulse-mascot.svg"');
    // Decorative: the wordmark above it already says the name.
    expect(html).toContain('alt=""');
    expect(html).toContain("items-center");
  });
});

describe("the theme control", () => {
  it("is a shut disclosure that names the theme it is on", () => {
    const html = renderToString(<ThemeToggle />);

    // The trigger's box is what becomes the panel (recipe 20), so `data-open`
    // and `aria-expanded` are the same shut state said twice: once to CSS, once
    // to a screen reader.
    expect(html).toContain('data-open="false"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Theme: system"');
  });

  it("lists all three themes and marks the current one", () => {
    const html = renderToString(<ThemeToggle />);

    for (const label of ["System", "Light", "Dark"]) expect(html).toContain(label);
    expect(html).toContain('role="group" aria-label="Theme"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    // Three icons in one exchange slot, showing the system one.
    expect(html).toContain('class="t-icon-swap" data-state="a"');
    for (const slot of ["a", "b", "c"]) expect(html).toContain(`data-icon="${slot}"`);
  });
});

describe("the live badge", () => {
  it("names each connection state in words, not only in colour", () => {
    expect(renderToString(<LiveBadge state="live" />)).toContain("Live");
    expect(renderToString(<LiveBadge state="connecting" />)).toContain("Connecting…");

    const offline = renderToString(<LiveBadge state="offline" />);
    expect(offline).toContain("Offline");
    // A visitor has to be able to tell a paused page from a working one.
    expect(offline).toContain("Reconnecting");
  });

  it("moves only while something is happening", () => {
    // Live is being pushed to, so the dot pulses; connecting is work in
    // progress, so the word shimmers; offline is a state, so neither moves.
    expect(renderToString(<LiveBadge state="live" />)).toContain("t-live-dot");
    expect(renderToString(<LiveBadge state="connecting" />)).toContain(
      'data-text="Connecting…"',
    );

    const offline = renderToString(<LiveBadge state="offline" />);
    expect(offline).not.toContain("t-live-dot");
    expect(offline).not.toContain("t-shimmer");
  });

  it("marks itself as a status region so a change is announced", () => {
    expect(renderToString(<LiveBadge state="live" />)).toContain('role="status"');
  });
});
