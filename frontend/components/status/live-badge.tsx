import type { LiveState } from "@/lib/live";

const COPY: Record<LiveState, { label: string; title: string; dot: string }> = {
  live: {
    label: "Live",
    title: "Updates arrive as each check completes.",
    // The tone is set as text colour too, because the pulse ring reads
    // `currentColor`.
    dot: "bg-up text-up",
  },
  connecting: {
    label: "Connecting…",
    title: "Opening the live connection.",
    dot: "bg-pending",
  },
  offline: {
    label: "Offline",
    title: "Reconnecting. What is on screen is as of the last update received.",
    dot: "bg-down",
  },
};

/**
 * Whether the page is actually being pushed to. A dashboard that shows old data
 * as if it were current is worse than one that admits it is behind, so the state
 * is a word and a tooltip, never a colour on its own.
 *
 * The dot pulses only while the connection is live and the word only shimmers
 * while it is being opened: motion here means activity, and `Live`/`Offline` are
 * states rather than activity. Under `prefers-reduced-motion` the motion goes
 * and the word stays, which is the same information (DECISIONS #6).
 */
export function LiveBadge({ state }: { state: LiveState }) {
  const { label, title, dot } = COPY[state];

  return (
    <span
      role="status"
      title={title}
      className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${dot}${state === "live" ? " t-live-dot" : ""}`}
        aria-hidden
      />
      {state === "connecting" ? (
        <span className="t-shimmer" data-text={label}>
          {label}
        </span>
      ) : (
        label
      )}
    </span>
  );
}
