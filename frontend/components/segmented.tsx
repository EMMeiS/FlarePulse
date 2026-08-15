import { useLayoutEffect, useRef } from "react";

/**
 * Tabs sliding (transitions.dev 16), shared by the status page's window
 * switcher and the admin's four sections — one control, two call sites, instead
 * of a measured pill in one place and a row of loose buttons in the other.
 *
 * These stay plain `aria-pressed` buttons rather than the recipe's
 * `role="tablist"` / `aria-selected` (DECISIONS #6): they switch a view and own
 * no tab panels, so claiming tab semantics would promise arrow-key navigation
 * that does not exist.
 *
 * The pill travels with a ghost that lags behind it, both inside one
 * SVG-filtered layer (see `SvgDefs`). The filter merges them into a single
 * liquid shape that stretches apart mid-travel and settles back together — the
 * metaball trick from gooey.jakubantalik.com. Labels live outside that layer:
 * the filter composites to the blob's silhouette, so text inside it would be
 * clipped wherever the blob is not.
 */
interface SegmentedProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  label: string;
  onSelect: (value: T) => void;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  label,
  onSelect,
  className = "",
}: SegmentedProps<T>) {
  const bar = useRef<HTMLDivElement>(null);
  const settled = useRef(false);

  // The pill follows the pressed button's measured box; CSS owns the tween. The
  // first placement and every resize are written with the transition suspended,
  // so it snaps into position instead of sliding in from the left.
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const root = bar.current;
      const button = root?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!root || !button) return;

      const transform = `translate(${button.offsetLeft}px, ${button.offsetTop}px)`;
      const width = `${button.offsetWidth}px`;
      for (const span of root.querySelectorAll<HTMLElement>(".t-tabs-pill, .t-tabs-ghost")) {
        if (!animate) span.style.transition = "none";
        span.style.transform = transform;
        span.style.width = width;
        if (!animate) {
          void span.offsetWidth;
          span.style.transition = "";
        }
      }
    };

    place(settled.current);
    settled.current = true;

    const snap = () => place(false);
    globalThis.addEventListener("resize", snap);
    return () => globalThis.removeEventListener("resize", snap);
  }, [value]);

  return (
    <div className={`t-tabs ${className}`} role="group" aria-label={label} ref={bar}>
      <span className="t-goo" aria-hidden>
        <span className="t-tabs-ghost" />
        <span className="t-tabs-pill" />
      </span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="t-tab text-xs font-medium sm:text-sm"
          aria-pressed={option.value === value}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
