import { useState } from "react";
import type { ChannelType, NotificationChannel } from "../../../src/db";
import { Pending, type PendingState } from "@/components/pending";
import { Switch } from "@/components/switch";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface ChannelBody {
  type: ChannelType;
  name: string;
  url: string | null;
  bot_token: string | null;
  chat_id: string | null;
  enabled: boolean;
}

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: "Webhook",
  discord: "Discord",
  telegram: "Telegram",
};

const URL_HINT: Record<"webhook" | "discord", string> = {
  webhook: "FlarePulse posts its own JSON here: the site name, the message text and an events array.",
  discord: "The channel's webhook URL, from Discord's Integrations settings.",
};

function text(data: FormData, key: string): string {
  return String(data.get(key) ?? "").trim();
}

function body(form: HTMLFormElement, type: ChannelType): ChannelBody {
  const data = new FormData(form);
  const telegram = type === "telegram";

  return {
    type,
    name: text(data, "name"),
    url: telegram ? null : text(data, "url"),
    bot_token: telegram ? text(data, "bot_token") : null,
    chat_id: telegram ? text(data, "chat_id") : null,
    enabled: data.get("enabled") !== null,
  };
}

interface Props {
  channel: NotificationChannel | null;
  onSubmit: (values: ChannelBody) => void;
  onCancel: () => void;
  pending: PendingState;
}

/**
 * One form for all three channel types. The selected type is the only local
 * state here, because which credentials a channel needs depends on it — and
 * asking a Telegram bot for a webhook URL is how a form teaches the wrong thing.
 */
export function ChannelForm({ channel, onSubmit, onCancel, pending }: Props) {
  const [type, setType] = useState<ChannelType>(channel?.type ?? "webhook");

  return (
    <form
      className="glass space-y-4 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(body(event.currentTarget, type));
      }}
    >
      <h3 className="font-semibold tracking-tight">
        {channel ? `Edit ${channel.name}` : "Add channel"}
      </h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="channel-name" label="Name">
          <Input
            id="channel-name"
            name="name"
            required
            maxLength={64}
            defaultValue={channel?.name ?? ""}
          />
        </Field>

        <Field id="channel-type" label="Type">
          <Select
            id="channel-type"
            name="type"
            value={type}
            onChange={(event) => setType(event.currentTarget.value as ChannelType)}
          >
            {(Object.keys(TYPE_LABEL) as ChannelType[]).map((option) => (
              <option key={option} value={option}>
                {TYPE_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {type === "telegram" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="channel-token" label="Bot token" hint="From @BotFather. Stored as typed.">
            <Input
              id="channel-token"
              name="bot_token"
              required
              maxLength={200}
              defaultValue={channel?.bot_token ?? ""}
            />
          </Field>

          <Field id="channel-chat" label="Chat id" hint="For example -1001234567890.">
            <Input
              id="channel-chat"
              name="chat_id"
              required
              maxLength={64}
              defaultValue={channel?.chat_id ?? ""}
            />
          </Field>
        </div>
      ) : (
        <Field id="channel-url" label="URL" hint={URL_HINT[type]}>
          <Input
            id="channel-url"
            name="url"
            type="url"
            required
            maxLength={500}
            defaultValue={channel?.url ?? ""}
          />
        </Field>
      )}

      <Switch
        id="channel-enabled"
        name="enabled"
        defaultChecked={channel === null || channel.enabled === 1}
        label="Enabled"
      />

      <p className="text-muted-foreground text-xs">
        One message per channel per check tick, on state changes only. A channel that is briefly
        unreachable loses that message — there is no retry.
      </p>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending === "busy"}>
          <Pending state={pending} />
          {channel ? "Save channel" : "Add channel"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
