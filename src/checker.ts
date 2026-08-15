import { dispatchTransitions, transitionOf, type MonitorTransition } from "./alerts";
import { runCheck } from "./checks";
import type { CheckStatus, Monitor, MonitorStatus } from "./db";
import { dueMonitors, recordCheck } from "./db";
import type { StatusUpdate } from "./monitor-hub";

export interface MonitorState {
  monitorStatus: MonitorStatus;
  failStreak: number;
  nextCheckAt: number;
}

/**
 * The down-transition rule, as a pure function — no clock, no bindings.
 *
 * `retries` is *extra* attempts, the meaning the default of 2 carries:
 * a monitor goes down on the third consecutive failure. Inside that window the
 * monitor keeps its previous status while the individual failures are already
 * visible as red heartbeats.
 */
export function nextState(monitor: Monitor, status: CheckStatus, checkedAt: number): MonitorState {
  const failStreak = status === "up" ? 0 : monitor.fail_streak + 1;

  return {
    monitorStatus:
      status === "up" ? "up" : failStreak > monitor.retries ? "down" : monitor.status,
    failStreak,
    nextCheckAt: checkedAt + monitor.interval_seconds,
  };
}

/**
 * One cron tick: everything that touches a binding lives here, so the decision
 * above and the probes in `checks.ts` stay testable on their own.
 *
 * Probes run concurrently because a serial pass of 20 monitors with 10 s
 * timeouts would outlast the minute it is supposed to fit in. At twenty monitors
 * that is well under the free plan's 50 external subrequests per invocation.
 */
export async function runDueChecks(env: Env, now: number): Promise<number> {
  const monitors = await dueMonitors(env.DB, now);
  if (monitors.length === 0) return 0;

  const checked = await Promise.all(
    monitors.map(async (monitor) => ({ monitor, outcome: await runCheck(monitor) })),
  );

  const moved = await Promise.all(
    checked.map(async ({ monitor, outcome }) => {
      const state = nextState(monitor, outcome.status, now);

      await recordCheck(env.DB, {
        monitorId: monitor.id,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        message: outcome.message,
        checkedAt: now,
        ...state,
      });

      // The comparison is free here: the next status was just computed.
      const to = transitionOf(monitor.status, state.monitorStatus);
      return {
        update: {
          monitorId: monitor.id,
          status: state.monitorStatus,
          check: outcome.status,
          latencyMs: outcome.latencyMs,
          checkedAt: now,
          isPublic: monitor.is_public === 1,
        } satisfies StatusUpdate,
        transition: to
          ? ({ monitor, to, message: outcome.message } satisfies MonitorTransition)
          : null,
      };
    }),
  );

  // One call, not one per monitor: every RPC call is a billed Durable Object
  // request, and the hub fans this out to the open dashboards in one frame.
  const hub = env.MONITOR_HUB.get(env.MONITOR_HUB.idFromName("global"));
  await hub.setStatuses(moved.map(({ update }) => update));

  await dispatchTransitions(
    env,
    moved.map(({ transition }) => transition).filter((transition) => transition !== null),
    now,
  );

  return monitors.length;
}
