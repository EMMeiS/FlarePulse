import ChevronDown from "reicon-react/icons/ChevronDown";
import type { AdminMonitor } from "../../../src/db";
import { RowMenu } from "@/components/row-menu";
import { StatusBar, type Segment } from "@/components/status/monitor-card";
import { formatDateTime, formatLatency, relativeTime, STATUS_LABEL } from "@/lib/format";
import type { BarSample } from "@/lib/live";

const DOT: Record<AdminMonitor["status"], string> = {
  up: "bg-up",
  down: "bg-down",
  pending: "bg-pending",
};

interface Props {
  monitors: AdminMonitor[];
  now: number;
  /** The one row whose heartbeats are open — one fetch at a time, not twenty. */
  openMonitor: number | null;
  /** That row's checks, oldest first, or null while they are still loading. */
  heartbeats: BarSample[] | null;
  onToggle: (monitor: AdminMonitor) => void;
  onEdit: (monitor: AdminMonitor) => void;
  onDelete: (monitor: AdminMonitor) => void;
}

/**
 * The authenticated list: target and schedule included, because an admin who
 * cannot see the target cannot edit it. Status is a word as well as a colour.
 */
export function MonitorTable({
  monitors,
  now,
  openMonitor,
  heartbeats,
  onToggle,
  onEdit,
  onDelete,
}: Props) {
  if (monitors.length === 0) {
    return (
      <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">No monitors yet.</p>
    );
  }

  return (
    <ul className="glass glass-popover divide-y rounded-xl border">
      {monitors.map((monitor) => {
        const open = openMonitor === monitor.id;
        const panelId = `monitor-${monitor.id}-heartbeats`;

        return (
          <li key={monitor.id} className="t-acc p-4" data-open={open ? "true" : "false"}>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`size-2.5 shrink-0 rounded-full ${DOT[monitor.status]}`}
                aria-hidden
              />

              <div className="min-w-48 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {monitor.name}
                  <span className="text-muted-foreground text-xs font-normal">
                    {monitor.enabled === 1
                      ? STATUS_LABEL[monitor.status]
                      : `${STATUS_LABEL[monitor.status]} · Paused`}
                  </span>
                </p>
                <p className="text-muted-foreground truncate text-xs">{monitor.target}</p>
                <p className="text-muted-foreground text-xs">
                  {`${monitor.type.toUpperCase()} · every ${monitor.interval_seconds}s · ${
                    monitor.group_name ?? "Ungrouped"
                  } · checked ${relativeTime(monitor.last_checked_at, now)}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={`Heartbeats for ${monitor.name}`}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="text-muted-foreground hover:text-foreground hover:bg-foreground/8 inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs transition-colors"
                  onClick={() => onToggle(monitor)}
                >
                  Heartbeats
                  <span className="t-acc-chevron">
                    <ChevronDown className="size-3" aria-hidden />
                  </span>
                </button>
                <RowMenu
                  label={`Actions for ${monitor.name}`}
                  actions={[
                    { label: "Edit", onSelect: () => onEdit(monitor) },
                    { label: "Delete", onSelect: () => onDelete(monitor), destructive: true },
                  ]}
                />
              </div>
            </div>

            {/* Always mounted, so the height can animate and the chevron has
                something to point at. `t-acc` on the row owns the open state;
                the same accordion the public card uses, not a second one. */}
            <div className="t-acc-panel" aria-hidden={!open}>
              <div id={panelId} className="t-acc-panel-inner pt-3">
                {heartbeats === null ? (
                  <p className="text-muted-foreground text-xs">Loading heartbeats…</p>
                ) : (
                  <Heartbeats monitor={monitor} heartbeats={heartbeats} />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The same bar the public card draws, from rows that also carry the check's
 * message — the one thing an admin has that a visitor must not: a check output
 * can name the target.
 */
function Heartbeats({
  monitor,
  heartbeats,
}: {
  monitor: AdminMonitor;
  heartbeats: BarSample[];
}) {
  const segments: Segment[] = heartbeats.map((heartbeat) => ({
    key: heartbeat.checked_at,
    uptime: heartbeat.status === "up" ? 100 : 0,
    title: `${formatDateTime(heartbeat.checked_at)} · ${heartbeat.status} · ${formatLatency(
      heartbeat.latency_ms,
    )}${heartbeat.message === null ? "" : ` · ${heartbeat.message}`}`,
  }));
  const last = heartbeats.at(-1);

  return (
    <div className="space-y-2">
      <StatusBar
        segments={segments}
        label={`Last ${segments.length} checks for ${monitor.name}`}
      />
      {last?.message === null || last === undefined ? null : (
        <p className="text-muted-foreground text-xs">
          {`Last check: ${last.message}`}
        </p>
      )}
    </div>
  );
}
