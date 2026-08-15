import type { AdminMonitor, MonitorGroup, MonitorType } from "../../../src/db";
import { MIN_INTERVAL_SECONDS } from "../../../src/limits";
import { Pending, type PendingState } from "@/components/pending";
import { Switch } from "@/components/switch";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface MonitorBody {
  name: string;
  type: MonitorType;
  target: string;
  interval_seconds: number;
  timeout_ms: number;
  retries: number;
  expected_status: number | null;
  keyword: string | null;
  keyword_invert: boolean;
  group_id: number | null;
  enabled: boolean;
}

const TYPE_LABEL: Record<MonitorType, string> = {
  http: "HTTP(S)",
  tcp: "TCP",
  dns: "DNS",
};

const TARGET_HINT: Record<MonitorType, string> = {
  http: "A full URL, e.g. https://api.example.com/health",
  tcp: "host:port, e.g. db.example.com:5432 — proves the handshake completed, nothing more",
  dns: "A hostname to resolve, e.g. example.com",
};

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? "").trim();
}

function optionalNumber(data: FormData, key: string): number | null {
  const value = text(data, key);
  return value === "" ? null : Number(value);
}

function body(form: HTMLFormElement): MonitorBody {
  const data = new FormData(form);
  return {
    name: text(data, "name"),
    type: text(data, "type") as MonitorType,
    target: text(data, "target"),
    interval_seconds: Number(data.get("interval_seconds")),
    timeout_ms: Number(data.get("timeout_ms")),
    retries: Number(data.get("retries")),
    expected_status: optionalNumber(data, "expected_status"),
    keyword: text(data, "keyword") === "" ? null : text(data, "keyword"),
    keyword_invert: data.get("keyword_invert") !== null,
    group_id: optionalNumber(data, "group_id"),
    enabled: data.get("enabled") !== null,
  };
}

interface Props {
  monitor: AdminMonitor | null;
  groups: MonitorGroup[];
  onSubmit: (values: MonitorBody) => void;
  onCancel: () => void;
  pending: PendingState;
}

/**
 * One form for create and edit. Everything the API accepts is here, with the
 * platform's two honest limits printed next to the fields they constrain rather
 * than only in the public footer the admin never reads.
 */
export function MonitorForm({ monitor, groups, onSubmit, onCancel, pending }: Props) {
  return (
    <form
      className="glass space-y-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(body(event.currentTarget));
      }}
    >
      <h3 className="font-semibold tracking-tight">
        {monitor ? `Edit ${monitor.name}` : "Add monitor"}
      </h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="monitor-name" label="Name">
          <Input
            id="monitor-name"
            name="name"
            required
            maxLength={64}
            defaultValue={monitor?.name ?? ""}
          />
        </Field>

        <Field id="monitor-type" label="Type" hint="Workers cannot send raw ICMP, so there is no ping monitor.">
          <Select id="monitor-type" name="type" defaultValue={monitor?.type ?? "http"}>
            {(Object.keys(TYPE_LABEL) as MonitorType[]).map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="monitor-target"
          label="Target"
          hint={TARGET_HINT[monitor?.type ?? "http"]}
        >
          <Input
            id="monitor-target"
            name="target"
            required
            maxLength={255}
            defaultValue={monitor?.target ?? ""}
          />
        </Field>

        <Field
          id="monitor-interval"
          label="Interval (seconds)"
          hint="Minimum 60 seconds — the fastest a Cloudflare cron trigger fires."
        >
          <Input
            id="monitor-interval"
            name="interval_seconds"
            type="number"
            min={MIN_INTERVAL_SECONDS}
            max={86_400}
            step={1}
            required
            defaultValue={monitor?.interval_seconds ?? MIN_INTERVAL_SECONDS}
          />
        </Field>

        <Field id="monitor-timeout" label="Timeout (ms)">
          <Input
            id="monitor-timeout"
            name="timeout_ms"
            type="number"
            min={1_000}
            max={30_000}
            step={100}
            required
            defaultValue={monitor?.timeout_ms ?? 10_000}
          />
        </Field>

        <Field id="monitor-retries" label="Retries before down">
          <Input
            id="monitor-retries"
            name="retries"
            type="number"
            min={0}
            max={10}
            step={1}
            required
            defaultValue={monitor?.retries ?? 2}
          />
        </Field>

        <Field
          id="monitor-status"
          label="Expected status"
          hint="HTTP only. Blank accepts any 2xx or 3xx."
        >
          <Input
            id="monitor-status"
            name="expected_status"
            type="number"
            min={100}
            max={599}
            step={1}
            defaultValue={monitor?.expected_status ?? ""}
          />
        </Field>

        <Field id="monitor-keyword" label="Keyword" hint="HTTP only. Blank skips the body check.">
          <Input
            id="monitor-keyword"
            name="keyword"
            maxLength={200}
            defaultValue={monitor?.keyword ?? ""}
          />
        </Field>

        <Field id="monitor-group" label="Group">
          <Select id="monitor-group" name="group_id" defaultValue={monitor?.group_id ?? ""}>
            <option value="">Ungrouped (public)</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-4">
        <Switch
          id="monitor-invert"
          name="keyword_invert"
          defaultChecked={monitor?.keyword_invert === 1}
          label="Fail when the keyword is present"
        />

        <Switch
          id="monitor-enabled"
          name="enabled"
          defaultChecked={monitor === null || monitor.enabled === 1}
          label="Enabled"
        />
      </div>

      <p className="text-muted-foreground text-xs">
        Checks run from one Cloudflare-selected location, so this measures reachability from a
        single vantage point.
      </p>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending === "busy"}>
          <Pending state={pending} />
          {monitor ? "Save monitor" : "Add monitor"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
