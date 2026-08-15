import { useEffect, useRef } from "react";
import { TONE_TEXT, type Tone } from "@/lib/format";

/**
 * A drawn orb, after the "Connecting" orb at orbs.jakubantalik.com — the
 * reference's `web` renderer: nodes scattered over a sphere, linked to whichever
 * neighbours are close enough, with a few signals travelling between them.
 * Canvas and `sin`/`cos` — no WebGL, no shader, no library.
 *
 * A network settling into itself is the right picture for this page: the thing
 * being watched is a set of endpoints and the paths between them.
 *
 * It is decoration, and deliberately dumb: the same speed whatever the page's
 * status is. Motion that carried meaning would take that meaning away from
 * everyone who has asked their OS for less of it (DECISIONS #6). The tone only
 * tints it — red when everything is down, amber when some of it is, green when
 * none of it is — and the headline beside it is what says so in words.
 *
 * The engineering is the part worth copying from the reference, and it is copied
 * whole: device pixel ratio capped at 2, the loop paused when the orb scrolls
 * out of view or the tab is hidden, one static frame and no loop at all under
 * `prefers-reduced-motion`, and a redraw when the theme flips so the static
 * frame is not left in the old palette.
 */
const NODES = 41; // the reference's nodeN 30, at the 64-tier count of 1.35
const SIGNALS = 7; // likewise its signals 5
const SPEED = 3.315; // the 64 tier's own time scale; every rate below is its
const SPIN = 0.12; //  coefficient from the reference, read against that clock
const TILT = 0.32;
const THRESHOLD = 0.72; // link two nodes closer than this, on the unit sphere
const JITTER = 0.17; // how far the noise pulls a node off its resting place
const NODE_R = 1.4;
const NODE_R_DEPTH = 1.8;
const NODE_SCALE = 0.95;
const LINE_W = 0.8;
const TWINKLE = 0.25;
const NODE_FAR = 0.35;
const NODE_SPAN = 0.5;
const LINK_FAR = 0.3;
const LINK_SPAN = 0.55;
const HOP = 2.4; // scaled seconds a signal spends crossing to its next node
const STILL_T = 2.1; // the pose the still frame is drawn in

/** Fibonacci sphere: the nodes' resting places, evenly spread, computed once. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const BASE = Array.from({ length: NODES }, (_, i) => {
  const y = 1 - (2 * i + 1) / NODES;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  return [Math.cos(GOLDEN * i) * ring, y, Math.sin(GOLDEN * i) * ring] as const;
});

/** Deterministic 0..1 from one number: which node a signal hops to next. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function Orb({
  tone,
  size = 112,
  className = "",
}: {
  tone: Tone;
  size?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context) return;

    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    el.width = size * ratio;
    el.height = size * ratio;

    // Reused every frame: the rotated position of each node, and where on the
    // canvas it landed. Allocating these inside the loop would hand the garbage
    // collector 60 arrays a second for no reason.
    const world = new Float64Array(NODES * 3);
    const screen = new Float64Array(NODES * 3);

    const draw = (t: number) => {
      const ink = getComputedStyle(el).color;
      const px = size * ratio;
      const middle = px / 2;
      const radius = middle * 0.8;
      const dot = ratio * NODE_SCALE;
      context.clearRect(0, 0, px, px);
      context.fillStyle = ink;
      context.strokeStyle = ink;
      context.lineWidth = Math.max(0.6, LINE_W * dot);

      const cosSpin = Math.cos(t * SPIN);
      const sinSpin = Math.sin(t * SPIN);
      const cosTilt = Math.cos(TILT);
      const sinTilt = Math.sin(TILT);

      for (let i = 0; i < NODES; i += 1) {
        // Pulled off the lattice by three out-of-step waves and pushed back onto
        // the sphere, so the web breathes without any node drifting inward.
        const jx = BASE[i][0] + JITTER * Math.sin(t * 0.9 + i * 2.1);
        const jy = BASE[i][1] + JITTER * Math.sin(t * 1.1 + i * 3.7);
        const jz = BASE[i][2] + JITTER * Math.sin(t * 0.8 + i * 5.3);
        const len = Math.hypot(jx, jy, jz) || 1;
        const x = jx / len;
        const y = jy / len;
        const z = jz / len;

        // Spun about the vertical, then tilted towards the viewer.
        const sx = x * cosSpin + z * sinSpin;
        const spun = z * cosSpin - x * sinSpin;
        world[i * 3] = sx;
        world[i * 3 + 1] = y * cosTilt - spun * sinTilt;
        world[i * 3 + 2] = spun * cosTilt + y * sinTilt;

        screen[i * 3] = middle + sx * radius;
        screen[i * 3 + 1] = middle - world[i * 3 + 1] * radius;
        screen[i * 3 + 2] = (world[i * 3 + 2] + 1) / 2; // 0 far, 1 near
      }

      // The web itself. Orthographic projection, so a link is just a line
      // between two projected nodes; depth only decides how strongly it reads.
      for (let i = 0; i < NODES; i += 1) {
        for (let j = i + 1; j < NODES; j += 1) {
          const gap = Math.hypot(
            world[i * 3] - world[j * 3],
            world[i * 3 + 1] - world[j * 3 + 1],
            world[i * 3 + 2] - world[j * 3 + 2],
          );
          if (gap >= THRESHOLD) continue;
          const depth = (screen[i * 3 + 2] + screen[j * 3 + 2]) / 2;
          context.globalAlpha = (1 - gap / THRESHOLD) * (LINK_FAR + LINK_SPAN * depth);
          context.beginPath();
          context.moveTo(screen[i * 3], screen[i * 3 + 1]);
          context.lineTo(screen[j * 3], screen[j * 3 + 1]);
          context.stroke();
        }
      }

      for (let i = 0; i < NODES; i += 1) {
        const depth = screen[i * 3 + 2];
        context.globalAlpha = NODE_FAR + NODE_SPAN * depth;
        context.beginPath();
        context.arc(
          screen[i * 3],
          screen[i * 3 + 1],
          (NODE_R + NODE_R_DEPTH * depth) * dot * (1 + TWINKLE * Math.sin(t * 1.4 + i * 2.7)),
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      // Signals. Each picks its next node by hash rather than by following a
      // link, which is the reference's own shortcut, and fades in and out of the
      // nodes it leaves and arrives at so the jump between hops is never seen.
      for (let s = 0; s < SIGNALS; s += 1) {
        const seed = s * 7.13;
        const phase = t / HOP + hash(seed) * 3;
        const hop = Math.floor(phase);
        const from = Math.floor(hash(hop + seed) * NODES) % NODES;
        const to = Math.floor(hash(hop + 1 + seed) * NODES) % NODES;
        if (from === to) continue;

        const p = phase - hop;
        const eased = p * p * (3 - 2 * p);
        const depth =
          screen[from * 3 + 2] + (screen[to * 3 + 2] - screen[from * 3 + 2]) * eased;
        context.globalAlpha = (0.45 + 0.5 * depth) * Math.sin(Math.PI * p);
        context.beginPath();
        context.arc(
          screen[from * 3] + (screen[to * 3] - screen[from * 3]) * eased,
          screen[from * 3 + 1] + (screen[to * 3 + 1] - screen[from * 3 + 1]) * eased,
          (NODE_R * 1.5 + NODE_R_DEPTH * depth) * dot,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      context.globalAlpha = 1;
    };

    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    const still = reduced?.matches === true;
    let last = STILL_T;

    // A theme flip changes `color`, and a still orb would keep the old ink.
    const themes = new MutationObserver(() => draw(still ? STILL_T : last));
    themes.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme"],
    });

    if (still) {
      draw(STILL_T);
      return () => themes.disconnect();
    }

    let frame = 0;
    let visible = true;
    let onScreen = true;
    const tick = (time: number) => {
      last = (time / 1000) * SPEED;
      draw(last);
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      const run = visible && onScreen;
      if (run && !frame) frame = requestAnimationFrame(tick);
      if (!run && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const hidden = () => {
      visible = document.visibilityState === "visible";
      sync();
    };
    document.addEventListener("visibilitychange", hidden);

    const watcher = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    watcher.observe(el);

    sync();
    return () => {
      themes.disconnect();
      watcher.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [size]);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={`${TONE_TEXT[tone]} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
