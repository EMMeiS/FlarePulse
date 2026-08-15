import type { AdminMonitor, Incident, IncidentStatus, MaintenanceWindow } from "../../../src/db";
import { Pending, type PendingState } from "@/components/pending";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

export interface IncidentBody {
  title: string;
  body: string | null;
  status: IncidentStatus;
  monitor_id: number | null;
}

export interface MaintenanceBody {
  title: string;
  body: string | null;
  starts_at: number;
  ends_at: number;
}

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? "").trim();
}

function nullable(data: FormData, key: string): string | null {
  const value = text(data, key);
  return value === "" ? null : value;
}

/** A `datetime-local` value is local wall time, which is what the admin typed. */
function localInput(seconds: number): string {
  const date = new Date(seconds * 1_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function unixSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1_000);
}

function Actions({
  pending,
  label,
  onCancel,
}: {
  pending: PendingState;
  label: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button type="submit" disabled={pending === "busy"}>
        <Pending state={pending} />
        {label}
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

interface IncidentProps {
  incident: Incident | null;
  monitors: AdminMonitor[];
  onSubmit: (values: IncidentBody) => void;
  onCancel: () => void;
  pending: PendingState;
}

/**
 * `resolved_at` is not a field: the API derives it from the status, so there is
 * no way to save an incident that is resolved and still open at the same time.
 */
export function IncidentForm({ incident, monitors, onSubmit, onCancel, pending }: IncidentProps) {
  return (
    <form
      className="glass space-y-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          title: text(data, "title"),
          body: nullable(data, "body"),
          status: text(data, "status") as IncidentStatus,
          monitor_id: text(data, "monitor_id") === "" ? null : Number(data.get("monitor_id")),
        });
      }}
    >
      <h3 className="font-semibold tracking-tight">
        {incident ? "Edit incident" : "Post an incident"}
      </h3>

      <Field id="incident-title" label="Title">
        <Input
          id="incident-title"
          name="title"
          required
          maxLength={120}
          defaultValue={incident?.title ?? ""}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="incident-status" label="Status" hint="Resolving stamps the end time for you.">
          <Select
            id="incident-status"
            name="status"
            defaultValue={incident?.status ?? "investigating"}
          >
            {(Object.keys(STATUS_LABEL) as IncidentStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="incident-monitor" label="Affected monitor">
          <Select
            id="incident-monitor"
            name="monitor_id"
            defaultValue={incident?.monitor_id ?? ""}
          >
            <option value="">Whole platform</option>
            {monitors.map((monitor) => (
              <option key={monitor.id} value={monitor.id}>
                {monitor.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field id="incident-body" label="Update" hint="Shown on the public timeline.">
        <Textarea
          id="incident-body"
          name="body"
          maxLength={4_000}
          defaultValue={incident?.body ?? ""}
        />
      </Field>

      <Actions
        pending={pending}
        label={incident ? "Save incident" : "Post incident"}
        onCancel={onCancel}
      />
    </form>
  );
}

interface MaintenanceProps {
  window: MaintenanceWindow | null;
  onSubmit: (values: MaintenanceBody) => void;
  onCancel: () => void;
  pending: PendingState;
}

export function MaintenanceForm({ window, onSubmit, onCancel, pending }: MaintenanceProps) {
  const now = Math.floor(Date.now() / 1_000);

  return (
    <form
      className="glass space-y-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          title: text(data, "title"),
          body: nullable(data, "body"),
          starts_at: unixSeconds(text(data, "starts_at")),
          ends_at: unixSeconds(text(data, "ends_at")),
        });
      }}
    >
      <h3 className="font-semibold tracking-tight">
        {window ? "Edit window" : "Schedule maintenance"}
      </h3>

      <Field id="maintenance-title" label="Title">
        <Input
          id="maintenance-title"
          name="title"
          required
          maxLength={120}
          defaultValue={window?.title ?? ""}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="maintenance-starts" label="Starts" hint="Your local time.">
          <Input
            id="maintenance-starts"
            name="starts_at"
            type="datetime-local"
            required
            defaultValue={localInput(window?.starts_at ?? now + 3_600)}
          />
        </Field>

        <Field id="maintenance-ends" label="Ends" hint="Must be after the start.">
          <Input
            id="maintenance-ends"
            name="ends_at"
            type="datetime-local"
            required
            defaultValue={localInput(window?.ends_at ?? now + 7_200)}
          />
        </Field>
      </div>

      <Field id="maintenance-body" label="Details" hint="Shown in the banner.">
        <Textarea
          id="maintenance-body"
          name="body"
          maxLength={4_000}
          defaultValue={window?.body ?? ""}
        />
      </Field>

      <Actions
        pending={pending}
        label={window ? "Save window" : "Schedule window"}
        onCancel={onCancel}
      />
    </form>
  );
}
