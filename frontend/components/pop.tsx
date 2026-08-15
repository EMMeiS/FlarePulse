/**
 * A value that re-enters when it changes: the `key` is the value itself, so a
 * new value remounts the span and replays the pop-in keyframe (transitions.dev
 * 02, number pop-in). No timers and no previous-value bookkeeping — React's
 * reconciler already knows when the string is different.
 *
 * The animation is decoration only. The string inside is the same string the
 * page would have rendered without it, which is what keeps the numbers
 * selectable and readable to a screen reader.
 */
export function Pop({ value, className }: { value: string; className?: string }) {
  return (
    <span key={value} className={className === undefined ? "t-pop" : `t-pop ${className}`}>
      {value}
    </span>
  );
}
