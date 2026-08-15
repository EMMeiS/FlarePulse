import { useEffect, useState } from "react";
import type { MonitorHistory, StatusPayload, StatusWindow } from "../src/status";
import { Hero } from "@/components/status/hero";
import { IncidentTimeline, MaintenanceBanner } from "@/components/status/incidents";
import { LiveBadge } from "@/components/status/live-badge";
import { MonitorCard } from "@/components/status/monitor-card";
import { PoweredBy } from "@/components/powered-by";
import { SvgDefs } from "@/components/svg-defs";
import { ThemeToggle } from "@/components/theme-toggle";
import { patchStatus, useLive } from "@/lib/live";

/**
 * The public page. Two endpoints: the whole page in one request, plus one
 * per-monitor series fetched only when a visitor opens a chart — a page with 20
 * monitors should not cost 20 queries to look at. From then on the socket moves
 * the numbers, so an open tab costs nothing per check.
 */
export function StatusPage() {
  const [activeWindow, setActiveWindow] = useState<StatusWindow>("24h");
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [openMonitor, setOpenMonitor] = useState<number | null>(null);
  const [history, setHistory] = useState<MonitorHistory | null>(null);
  // Bumped when the connection comes back: frames were missed, so the page
  // refetches rather than carrying on from a state it cannot trust.
  const [reload, setReload] = useState(0);

  const connection = useLive("/api/live", {
    onUpdates: (updates) =>
      setPayload((current) => (current ? patchStatus(current, updates) : current)),
    onResume: () => setReload((count) => count + 1),
  });

  useEffect(() => {
    let live = true;
    fetch(`/api/status?window=${activeWindow}`)
      .then((response) => response.json() as Promise<StatusPayload>)
      .then((next) => live && setPayload(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [activeWindow, reload]);

  useEffect(() => {
    if (openMonitor === null) return;
    let live = true;
    setHistory(null);
    fetch(`/api/status/monitors/${openMonitor}?window=${activeWindow}`)
      .then((response) => response.json() as Promise<MonitorHistory>)
      .then((next) => live && setHistory(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [openMonitor, activeWindow]);

  const now = Math.floor(Date.now() / 1_000);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:py-10">
      <div className="flex items-center justify-between gap-3">
        <LiveBadge state={connection} />
        <ThemeToggle />
      </div>

      {failed ? (
        <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">
          Status is temporarily unavailable.
        </p>
      ) : payload === null ? (
        <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">
          <span className="t-shimmer" data-text="Loading status…">
            Loading status…
          </span>
        </p>
      ) : (
        <>
          <Hero payload={payload} now={now} onWindow={setActiveWindow} />
          <MaintenanceBanner maintenance={payload.maintenance} now={now} />

          {payload.groups.map((group) => (
            <section key={group.id ?? "ungrouped"} className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
              {group.monitors.map((monitor) => (
                <MonitorCard
                  key={monitor.id}
                  monitor={monitor}
                  now={now}
                  window={payload.window}
                  history={openMonitor === monitor.id ? history : null}
                  expanded={openMonitor === monitor.id}
                  onToggle={() =>
                    setOpenMonitor((current) => (current === monitor.id ? null : monitor.id))
                  }
                />
              ))}
            </section>
          ))}

          <IncidentTimeline incidents={payload.incidents} now={now} />
        </>
      )}

      <Footer />
      {/* Last, not first: `space-y-6` puts a top margin on every child after the
          first, and a zero-sized filter host must not push the page down. */}
      <SvgDefs />
    </div>
  );
}

/** The limitations, stated rather than papered over. */
function Footer() {
  return (
    <footer className="text-muted-foreground space-y-2 border-t pt-6 text-xs">
      <p>
        Checks run from one Cloudflare-selected location, so a problem confined to one region may
        not appear here.
      </p>
      <p>
        The shortest interval is 60 seconds — the fastest a Cloudflare cron trigger fires. This page
        updates as each check completes, so what is on screen is at most one check old.
      </p>
      <p>
        Workers cannot send raw ICMP, so there is no ping monitor: HTTP, TCP and DNS only.
      </p>
      <PoweredBy />
    </footer>
  );
}
