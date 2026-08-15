import type { QuotaEstimate } from "../../../src/admin";
import { Pop } from "@/components/pop";

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * Steady-state arithmetic from the current monitors, not a bill. Worth a panel
 * because a 60-second monitor costs 1,440 D1 rows a day, and the useful moment
 * to learn where the Free plan runs out is before adding the monitor that does
 * it — not from a failing cron at 3am.
 *
 * Every figure pops when it changes: adding a monitor moves five numbers at once,
 * and the point of the panel is noticing which way they moved.
 */
export function QuotaCard({ quota }: { quota: QuotaEstimate }) {
  return (
    <div className="glass space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold tracking-tight">Free-plan headroom</h3>
        <p className="text-muted-foreground text-sm">
          <Pop value={`${quota.percent_used}% of the daily writes`} />
        </p>
      </div>

      <div className="bg-muted h-2 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(100, quota.percent_used)}%` }}
        />
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">D1 rows written per day</dt>
          <dd>
            <Pop
              value={`${NUMBER.format(quota.writes_per_day)} / ${NUMBER.format(quota.write_limit)}`}
            />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Checks per cron tick</dt>
          <dd>
            <Pop value={`${quota.checks_per_minute} / ${quota.subrequest_limit}`} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Enabled monitors</dt>
          <dd>
            <Pop value={`${quota.monitors}`} />
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Room at this rate</dt>
          <dd>
            <Pop value={`${quota.monitors_at_this_rate} more`} />
          </dd>
        </div>
      </dl>

      <p className="text-muted-foreground text-xs">
        An estimate of steady state from the intervals configured here — heartbeats plus the hourly
        and daily rollup rows. It is not a bill: the Cloudflare dashboard is the authority on actual
        usage.
      </p>
    </div>
  );
}
