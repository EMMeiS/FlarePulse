import { useEffect, useRef } from "react";

/**
 * The glyph slot on every button that starts a request (transitions.dev 10 for
 * the check, 09 for the exchange — the catalogue's own answer to what "spinner
 * to check morph" means). Three states: nothing at rest, a spinning ring while
 * the request is out, and a check that draws itself when it lands.
 *
 * At rest it renders nothing rather than an empty 16px box, so a button at rest
 * is the button it was before this component existed. The slot mounts already
 * spinning, which costs no transition — the exchange that matters is spinner to
 * check, and that one happens without a remount.
 *
 * The check's dasharray is measured from the path with `getTotalLength()` rather
 * than the recipe's placeholder number, which is the recipe's own advice: a
 * guessed length either leaves a stub of line showing or overshoots and stalls.
 */
export type PendingState = "idle" | "busy" | "done";

/** How long a landed check stays before the caller drops back to idle. */
export const DONE_MS = 1_200;

export function Pending({ state }: { state: PendingState }) {
  const check = useRef<SVGPathElement>(null);

  useEffect(() => {
    const path = check.current;
    if (!path) return;
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
  }, []);

  if (state === "idle") return null;

  return (
    <span
      className="t-icon-swap size-4 shrink-0"
      data-state={state === "busy" ? "b" : "c"}
      aria-hidden
    >
      {/* `t-spin` sits on the svg, not on the `.t-icon` wrapper: the swap
          animates `transform` too, and an animation on the same element would
          override the scale leg of the exchange. */}
      <span className="t-icon" data-icon="b">
        <svg viewBox="0 0 16 16" className="t-spin size-4">
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="30 12"
          />
        </svg>
      </span>

      <span
        className="t-icon t-success-check"
        data-icon="c"
        data-state={state === "done" ? "in" : "out"}
      >
        <svg viewBox="0 0 24 24" className="size-4">
          <path
            ref={check}
            d="M4.5 12.75 9.75 18 19.5 6.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
}
