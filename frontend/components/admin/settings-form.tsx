import type { Settings } from "../../../src/db";
import { Pending, type PendingState } from "@/components/pending";
import { Switch } from "@/components/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SettingsBody {
  site_name: string;
  auto_open_incidents: boolean;
  auto_resolve_incidents: boolean;
}

/** Branding plus the two global incident policies — every field the API honours. */
export function SettingsForm({
  settings,
  onSubmit,
  pending,
}: {
  settings: Settings;
  onSubmit: (values: SettingsBody) => void;
  pending: PendingState;
}) {
  return (
    <form
      className="glass space-y-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          site_name: String(data.get("site_name") ?? "").trim(),
          auto_open_incidents: data.get("auto_open_incidents") !== null,
          auto_resolve_incidents: data.get("auto_resolve_incidents") !== null,
        });
      }}
    >
      <h3 className="font-semibold tracking-tight">Site</h3>

      {/* A label stranded over a full-width input is the cheapest-looking thing
          a form can do, and this pane has exactly one text field for it to
          happen to. The first fix put the label and the value at opposite ends
          of one row, which only moved the problem: the pane is wide, so the two
          ended up a screen apart. This is the field Apple's own forms use — the
          label sits inside the box as a small caption and the value is set
          directly under it, in the size it will be read at, in a box no wider
          than a 32-character name needs.

          The label stays a real label: a placeholder would disappear the moment
          someone typed, and this value ends up as the public page's heading. The
          box carries the border and the focus ring, so the whole cell lights up;
          the input inside it is stripped of both. */}
      <div className="space-y-1.5 sm:max-w-sm">
        <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/50 grid gap-0.5 rounded-xl border px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]">
          <Label
            htmlFor="settings-site-name"
            className="text-muted-foreground text-xs font-normal"
          >
            Site name
          </Label>
          <Input
            id="settings-site-name"
            name="site_name"
            required
            maxLength={32}
            defaultValue={settings.site_name}
            className="h-auto border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          Shown as the heading on the public status page. Up to 32 characters.
        </p>
      </div>

      <div className="space-y-3">
        <Switch
          id="settings-auto-open"
          name="auto_open_incidents"
          defaultChecked={settings.auto_open_incidents === 1}
          label="Open an incident when a monitor goes down"
        />

        <Switch
          id="settings-auto-resolve"
          name="auto_resolve_incidents"
          defaultChecked={settings.auto_resolve_incidents === 1}
          label="Resolve it when the monitor recovers"
        />

        <p className="text-muted-foreground text-xs">
          Both apply to every monitor. Incidents you write by hand are never touched by either.
        </p>
      </div>

      <Button type="submit" disabled={pending === "busy"}>
        <Pending state={pending} />
        Save
      </Button>
    </form>
  );
}
