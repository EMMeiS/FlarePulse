import { useEffect, useRef } from "react";

/**
 * Replays transitions.dev 12's shake whenever `attempt` changes, on a target that
 * cannot simply be remounted — a form card holds uncontrolled inputs, and keying
 * it would throw away what the user typed.
 *
 * The signal is a counter rather than the error message: two rejected sign-ins in
 * a row produce the same string, and the second one still has to shake.
 *
 * Removing the class, reading a layout property and adding it back is what makes
 * a CSS animation restart. Without the read in between, both mutations land in
 * one frame and the browser never sees the class leave.
 *
 * The element must carry `t-input`, which is the catalogue's own name for "a thing
 * that can go red and shake"; `.is-shaking` alone matches nothing, deliberately,
 * so a class this generic cannot animate something by accident.
 */
export function useShake<T extends HTMLElement>(attempt: number) {
  const target = useRef<T>(null);

  useEffect(() => {
    const element = target.current;
    if (element === null || attempt === 0) return;
    element.classList.remove("is-shaking");
    void element.offsetWidth;
    element.classList.add("is-shaking");
  }, [attempt]);

  return target;
}
