import type { MonitorStatus } from "../../src/db";
import type { OverallStatus } from "../../src/status";

/** Two decimals, and an em dash when there is nothing to average yet. */
export function formatUptime(uptime: number | null): string {
  return uptime === null ? "—" : `${uptime.toFixed(2)}%`;
}

export function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} ms`;
}

/** Coarse on purpose: a status page is read at a glance, not to the second. */
export function relativeTime(seconds: number | null, now: number): string {
  if (seconds === null) return "never";
  const elapsed = Math.max(0, now - seconds);
  if (elapsed < 60) return "just now";
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)} min ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)} h ago`;
  return `${Math.floor(elapsed / 86_400)} d ago`;
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(seconds: number): string {
  return DATE_TIME.format(seconds * 1_000);
}

export const STATUS_LABEL: Record<MonitorStatus, string> = {
  up: "Operational",
  down: "Down",
  pending: "No data yet",
};

/** The one sentence a visitor came for. */
export const OVERALL_HEADLINE: Record<OverallStatus, string> = {
  up: "All systems operational",
  partial: "Some systems are down",
  down: "Major outage",
  pending: "Waiting for the first checks",
};

/**
 * Which CSS colour token a value gets. Bucket uptime is not binary: a partial
 * bucket is neither up nor down, and painting it green would hide the dip the
 * chart exists to show.
 */
export function uptimeTone(uptime: number | null): "up" | "degraded" | "down" | "pending" {
  if (uptime === null) return "pending";
  if (uptime >= 100) return "up";
  return uptime > 0 ? "degraded" : "down";
}

export const WINDOW_LABEL = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
} as const;

export type Tone = "up" | "degraded" | "down" | "pending";

/** The page-level word in the same four tones the bars use. */
export function overallTone(overall: OverallStatus): Tone {
  return overall === "partial" ? "degraded" : overall;
}

/**
 * The colour tokens live in `index.css`; these are the only places that name
 * them, so a palette change is one file.
 */
export const TONE_BG: Record<Tone, string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  pending: "bg-pending",
};

export const TONE_TEXT: Record<Tone, string> = {
  up: "text-up",
  degraded: "text-degraded",
  down: "text-down",
  pending: "text-pending",
};

/**
 * The heartbeat bar's fills, which are a brighter set than `TONE_BG`,
 * matching the reference design. They are never used for a glyph, so they can be as
 * saturated as the reference without costing the status word its contrast.
 */
export const TONE_BAR: Record<Tone, string> = {
  up: "bg-up-bar",
  degraded: "bg-degraded-bar",
  down: "bg-down-bar",
  pending: "bg-pending-bar",
};
