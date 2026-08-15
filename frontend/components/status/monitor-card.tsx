import ChevronDown from "reicon-react/icons/ChevronDown";
import type { MonitorHistory, StatusMonitor, StatusWindow } from "../../../src/status";
import { Pop } from "@/components/pop";
import { Reel } from "@/components/reel";
import { LatencyChart } from "@/components/status/latency-chart";
import {
  formatDateTime,
  formatLatency,
  formatUptime,
  relativeTime,
  STATUS_LABEL,
  TONE_BAR,
  TONE_BG,
  TONE_TEXT,
  uptimeTone,
  WINDOW_LABEL,
} from "@/lib/format";

export interface Segment {
  key: string | number;
  uptime: number | null;
  title: string;
}

/**
 * The heartbeat bar and the per-bucket uptime strip are the same object with
 * different inputs: one segment per check, or one per chart bucket. Segments are
 * keyed by their own timestamp, so a new check mounts a new element and the
 * arrival keyframe plays exactly once for it.
 *
 * Shaped to `bar.png`: stadium segments — the radius is larger than the segment
 * is wide, so each one is a capsule however thin the row gets — a real gap
 * rather than a hairline, and the bright `TONE_BAR` fills instead of the text
 * tones. `flex-1` distributes them across the full width at any count.
 */
export function StatusBar({ segments, label }: { segments: Segment[]; label: string }) {
  if (segments.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks recorded yet.</p>;
  }

  return (
    <div className="flex h-7 items-stretch gap-[3px]" role="img" aria-label={label}>
      {segments.map((segment) => (
        <span
          key={segment.key}
          title={segment.title}
          className={`t-bar-seg min-w-[3px] flex-1 rounded-full ${
            TONE_BAR[uptimeTone(segment.uptime)]
          }`}
        />
      ))}
    </div>
  );
}

interface MonitorCardProps {
  monitor: StatusMonitor;
  now: number;
  window: StatusWindow;
  history: MonitorHistory | null;
  expanded: boolean;
  onToggle: () => void;
}

export function MonitorCard({
  monitor,
  now,
  window,
  history,
  expanded,
  onToggle,
}: MonitorCardProps) {
  const panelId = `monitor-${monitor.id}-history`;
  const heartbeats: Segment[] = monitor.heartbeats.map((heartbeat) => ({
    key: heartbeat.checked_at,
    uptime: heartbeat.status === "up" ? 100 : 0,
    title: `${formatDateTime(heartbeat.checked_at)} · ${heartbeat.status} · ${formatLatency(
      heartbeat.latency_ms,
    )}`,
  }));

  return (
    <article
      className="glass t-acc space-y-2.5 rounded-xl border p-4"
      data-open={expanded ? "true" : "false"}
    >
      {/* `bar.png`'s header: the name on the left in regular weight, the uptime
          percent hard right as the row's one bold number, the bar underneath.
          The status word, the latency and the check time drop to a quiet line
          below the bar — four values on one line was the old crowding. */}
      <div className="flex items-center justify-between gap-x-4">
        <h3 className="flex min-w-0 items-center gap-2">
          <span
            className={`size-2.5 shrink-0 rounded-full ${TONE_BG[monitor.status]} ${
              TONE_TEXT[monitor.status]
            }${monitor.status === "pending" ? "" : " t-live-dot"}`}
            aria-hidden
          />
          <span className="truncate">{monitor.name}</span>
          <span className="text-muted-foreground shrink-0 text-[0.6875rem] tracking-wide uppercase">
            {monitor.type}
          </span>
        </h3>
        <p className="flex shrink-0 items-center gap-1.5">
          <span className="text-lg font-semibold tabular-nums">
            <Reel value={formatUptime(monitor.uptime)} roll={window} />
          </span>
          <span className="text-muted-foreground text-xs">{window}</span>
        </p>
      </div>

      <StatusBar
        segments={heartbeats}
        label={`Last ${heartbeats.length} checks for ${monitor.name}`}
      />

      {/* The disclosure and its panel share one wrapper, because a collapsed
          panel is still a flow child: as a direct child of the card's stack it
          would leave the stack's gap behind as an empty strip. The panel stays
          mounted so its height can animate, and is hidden from assistive tech
          while collapsed rather than read as empty content. */}
      <div>
        <div className="text-muted-foreground flex items-center justify-between gap-4 text-xs">
          <span className="truncate">
            <span className={TONE_TEXT[monitor.status]}>
              <Pop value={STATUS_LABEL[monitor.status]} />
            </span>
            {" · "}
            <Pop value={formatLatency(monitor.latency_ms)} />
            {` · over ${WINDOW_LABEL[window]} · checked ${relativeTime(
              monitor.last_checked_at,
              now,
            )}`}
          </span>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            className="hover:text-foreground inline-flex shrink-0 items-center gap-1 underline-offset-4 hover:underline"
          >
            Response time
            <span className="t-acc-chevron">
              <ChevronDown className="size-3" aria-hidden />
            </span>
          </button>
        </div>

        <div className="t-acc-panel" aria-hidden={!expanded}>
          <div id={panelId} className="t-acc-panel-inner space-y-2 pt-3">
            {history ? (
              <>
                <LatencyChart points={history.points} />
                <StatusBar
                  segments={history.points.map((point) => ({
                    key: point.start,
                    uptime: point.uptime,
                    title: `${formatDateTime(point.start)} · ${formatUptime(point.uptime)}`,
                  }))}
                  label={`Uptime per bucket for ${monitor.name} over ${WINDOW_LABEL[window]}`}
                />
              </>
            ) : (
              <p
                className="text-muted-foreground t-shimmer text-xs"
                data-text="Loading response times…"
              >
                Loading response times…
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
