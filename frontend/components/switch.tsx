import { Label } from "@/components/ui/label";

/**
 * A toggle (transitions.dev 27) that is still a checkbox. `appearance: none`
 * turns the input itself into the track and its `::before` into the thumb, so
 * `name`, `defaultChecked`, `FormData` and the browser's own focus and label
 * behaviour are all untouched and no JavaScript owns the state.
 *
 * The recipe animates the thumb with two keyframe sets and an `.is-init` class
 * to stop them firing on mount. Here the thumb travels on a `translate`
 * transition with the recipe's overshoot easing instead: a transition does not
 * run on first paint, so the mount-bounce it guards against cannot happen and
 * the class is dead weight. Deviation, recorded in DECISIONS #12.
 *
 * The row is part of the component because all six call sites are the same row:
 * a track, a gap, and a label that clicks the track.
 */
interface SwitchProps extends Omit<React.ComponentProps<"input">, "type"> {
  id: string;
  label: React.ReactNode;
}

export function Switch({ label, className = "", ...input }: SwitchProps) {
  return (
    <div className="flex items-center gap-2">
      <input type="checkbox" className={`t-toggle ${className}`} {...input} />
      <Label htmlFor={input.id}>{label}</Label>
    </div>
  );
}
