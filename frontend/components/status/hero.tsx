import { useEffect, useState } from "react";
import Activity from "reicon-react/icons/Activity";
import type { StatusPayload, StatusWindow } from "../../../src/status";
import { Orb } from "@/components/orb";
import { Pop } from "@/components/pop";
import { Segmented } from "@/components/segmented";
import {
  OVERALL_HEADLINE,
  overallTone,
  relativeTime,
  TONE_BG,
  WINDOW_LABEL,
} from "@/lib/format";

const WINDOWS = (Object.keys(WINDOW_LABEL) as StatusWindow[]).map((value) => ({
  value,
  label: WINDOW_LABEL[value],
}));

interface HeroProps {
  payload: StatusPayload;
  now: number;
  onWindow: (window: StatusWindow) => void;
}

/**
 * The banner a visitor reads before anything else, and the only card with the
 * strong glass treatment (DECISIONS #11): copy that rises in once, and the
 * window switcher as a sliding pill.
 *
 * Nothing here answers the pointer. The card used to carry recipe 19's glare —
 * a light that followed the cursor across the glass — and it was cut deliberately:
 * the hero is something to read, not something to play with.
 */
export function Hero({ payload, now, onWindow }: HeroProps) {
  const tone = overallTone(payload.overall);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setShown(true);
  }, []);

  return (
    <header className="glass glass-hero rounded-xl border p-6 sm:p-8">
      <div className={`glass-content t-stagger space-y-5 ${shown ? "is-shown" : ""}`}>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <Activity className="size-5" aria-hidden />
            {payload.name}
          </span>
          <span className="text-muted-foreground text-xs">
            {`Updated ${relativeTime(payload.generated_at, now)}`}
          </span>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0 space-y-2">
            <h1 className="t-stagger-line t-stagger-line--1 flex items-center gap-3 text-2xl font-semibold sm:text-3xl">
              <span className={`size-3 shrink-0 rounded-full ${TONE_BG[tone]}`} aria-hidden />
              {OVERALL_HEADLINE[payload.overall]}
            </h1>

            <p className="text-muted-foreground t-stagger-line t-stagger-line--2 text-sm">
              <Pop
                value={`${payload.monitors_up} of ${payload.monitors_total} ${
                  payload.monitors_total === 1 ? "monitor" : "monitors"
                } operational`}
              />
              {" · checked every 60 seconds"}
            </p>
          </div>

          <Orb tone={tone} className="hidden shrink-0 sm:block" />
        </div>

        <Segmented
          options={WINDOWS}
          value={payload.window}
          label="History window"
          onSelect={onWindow}
        />
      </div>
    </header>
  );
}
