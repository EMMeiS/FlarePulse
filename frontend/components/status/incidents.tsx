import Calendar from "reicon-react/icons/Calendar";
import type { Incident, IncidentStatus, MaintenanceWindow } from "../../../src/db";
import { formatDateTime, relativeTime, TONE_BG, type Tone } from "@/lib/format";

/** How far along an incident is, in the same four tones the rest of the page uses. */
const INCIDENT_TONE: Record<IncidentStatus, Tone> = {
  investigating: "down",
  identified: "down",
  monitoring: "degraded",
  resolved: "up",
};

export function MaintenanceBanner({
  maintenance,
  now,
}: {
  maintenance: MaintenanceWindow[];
  now: number;
}) {
  if (maintenance.length === 0) return null;

  return (
    <section aria-label="Scheduled maintenance" className="space-y-2">
      {maintenance.map((window) => (
        <div
          key={window.id}
          className="border-maintenance/40 bg-maintenance/10 flex gap-3 rounded-xl border p-4"
        >
          <Calendar className="text-maintenance mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {`${window.starts_at <= now ? "Maintenance in progress" : "Scheduled maintenance"}: ${
                window.title
              }`}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {`${formatDateTime(window.starts_at)} — ${formatDateTime(window.ends_at)}`}
            </p>
            {window.body ? <p className="text-sm">{window.body}</p> : null}
          </div>
        </div>
      ))}
    </section>
  );
}

export function IncidentTimeline({
  incidents,
  now,
}: {
  incidents: Incident[];
  now: number;
}) {
  return (
    <section aria-labelledby="incidents" className="space-y-3">
      <h2 id="incidents" className="text-lg font-semibold tracking-tight">
        Recent incidents
      </h2>

      {incidents.length === 0 ? (
        <p className="text-muted-foreground text-sm">No incidents reported.</p>
      ) : (
        <ol className="space-y-3">
          {incidents.map((incident) => (
            <li key={incident.id} className="glass space-y-1 rounded-xl border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h3 className="flex items-center gap-2 font-medium">
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${TONE_BG[INCIDENT_TONE[incident.status]]}`}
                    aria-hidden
                  />
                  {incident.title}
                </h3>
                <p className="text-muted-foreground text-xs">{incident.status}</p>
              </div>
              <p className="text-muted-foreground text-xs tabular-nums">
                {`Started ${formatDateTime(incident.started_at)} · ${
                  incident.resolved_at === null
                    ? "ongoing"
                    : `resolved ${relativeTime(incident.resolved_at, now)}`
                }`}
              </p>
              {incident.body ? <p className="text-sm">{incident.body}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
