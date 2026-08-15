/**
 * The project mark and wordmark, centred, at the foot of both surfaces: the line
 * first, the mascot under it — it is a character rather than a monogram, so it
 * reads as a signature below the words rather than as a glyph inside them.
 *
 * An `<img>` rather than an inline SVG: the file is already a static asset the
 * browser caches and reuses for the favicon, and inlining it twice on one page
 * would give two elements the same gradient ids. `alt=""` because the wordmark
 * that always accompanies it already says the name — a screen reader should hear
 * it once.
 */
export function Mascot() {
  return <img src="/flarepulse-mascot.svg" alt="" width="52" height="56" className="mx-auto h-14 w-auto" />;
}

/**
 * `mark` is off on the signed-out admin screens, where the mascot sits above the
 * card instead: one page, one mascot.
 */
export function PoweredBy({ mark = true }: { mark?: boolean }) {
  return (
    <div className="flex flex-col items-center pt-8">
      {/* `leading-none` as well as no gap: the line box's own leading is most of the
          space between the words and the mascot, so trimming it is what closes the gap. */}
      <p className="text-muted-foreground text-sm leading-none">
        Powered by <span className="text-foreground font-semibold">FlarePulse</span>
      </p>
      {mark && <Mascot />}
    </div>
  );
}
