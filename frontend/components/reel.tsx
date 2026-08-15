import { useEffect, useRef } from "react";

/**
 * Spinning counter (transitions.dev 26) — a number that changes with fanfare.
 *
 * Each digit is a clipped column holding a strip of `(spins + 1) * 10` cells
 * cycling 0-9. The resting position is the cell showing the current digit near
 * the end of the strip; a roll jumps the strip back to the top with the
 * transition suspended and then tweens down to that cell, so the digit passes
 * through several full turns before landing. Columns are staggered, so the reel
 * settles left to right.
 *
 * The catalogue's own guidance applies: this is for a number whose change should
 * feel like an event. It is deliberately *not* wired to live updates — a value
 * that re-rolls while you are reading it is a value you cannot read — only to a
 * window change, which the visitor asked for.
 *
 * Offsets are percentages of the strip's own height rather than pixels, so the
 * cell size stays a CSS concern (`--reel-cell`) and nothing here has to agree
 * with it.
 */
const SPINS = 2;
const CELLS = Array.from({ length: (SPINS + 1) * 10 }, (_, index) => index % 10);
const rest = (digit: number) => `translateY(${(-(SPINS * 10 + digit) / CELLS.length) * 100}%)`;

export function Reel({ value, roll }: { value: string; roll: string }) {
  const root = useRef<HTMLSpanElement>(null);
  // First paint is already at rest from the inline transform below; a number
  // that spins itself up on page load is noise rather than an event.
  const rolled = useRef(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const first = !rolled.current;
    rolled.current = true;
    if (first) return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const strips = Array.from(el.querySelectorAll<HTMLElement>(".t-reel-strip"));
    const style = getComputedStyle(el);
    const duration = parseFloat(style.getPropertyValue("--reel-dur")) || 1400;
    const stagger = parseFloat(style.getPropertyValue("--reel-stagger")) || 90;
    const ease = style.getPropertyValue("--reel-ease").trim() || "ease-out";

    el.dataset.spinning = "true";
    strips.forEach((strip, column) => {
      strip.style.transition = "none";
      strip.style.transform = "translateY(0)";
      void strip.offsetHeight; // force reflow, or the jump back tweens too
      strip.style.transition = `transform ${duration}ms ${ease} ${column * stagger}ms`;
      strip.style.transform = rest(Number(strip.dataset.digit));
      strip.classList.add("is-spinning");
    });

    const timers = strips.map((strip, column) =>
      globalThis.setTimeout(() => {
        strip.classList.remove("is-spinning");
        // Hand the strip back to React snapped rather than tweening: a value
        // that arrives outside a roll should just be the new value.
        strip.style.transition = "none";
      }, duration + column * stagger),
    );
    const settle = globalThis.setTimeout(
      () => {
        if (root.current) delete root.current.dataset.spinning;
      },
      duration + Math.max(0, strips.length - 1) * stagger,
    );

    return () => {
      for (const timer of timers) globalThis.clearTimeout(timer);
      globalThis.clearTimeout(settle);
    };
    // Rolls when `roll` changes — the window the visitor picked — and never on a
    // value that merely arrived.
  }, [roll]);

  const chars = [...value];
  if (!chars.some((char) => char >= "0" && char <= "9")) {
    return <span>{value}</span>;
  }

  return (
    <>
      {/* One string, once, for a screen reader. The columns are ten copies of
          every digit and would otherwise be read as a wall of numbers. */}
      <span className="sr-only">{value}</span>
      <span className="t-reel" aria-hidden ref={root}>
        {chars.map((char, index) =>
          char >= "0" && char <= "9" ? (
            <span className="t-reel-col" key={index}>
              <span
                className="t-reel-strip"
                data-digit={char}
                style={{ transform: rest(Number(char)) }}
              >
                {CELLS.map((digit, cellIndex) => (
                  <span className="t-reel-digit" key={cellIndex}>
                    {digit}
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span className="t-reel-digit" key={index}>
              {char}
            </span>
          ),
        )}
      </span>
    </>
  );
}
