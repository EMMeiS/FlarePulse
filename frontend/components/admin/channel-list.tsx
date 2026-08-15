import type { ChannelType, NotificationChannel } from "../../../src/db";
import { relativeTime } from "@/lib/format";
import { Pending, type PendingState } from "@/components/pending";
import { RowMenu } from "@/components/row-menu";

const TYPE_LABEL: Record<ChannelType, string> = {
  webhook: "Webhook",
  discord: "Discord",
  telegram: "Telegram",
};

/**
 * What happened the last time FlarePulse used this channel. The row is the delivery
 * log: an error stays visible until a later send clears it, which is what makes
 * a lost alert noticeable without spending D1 writes on a history table.
 */
function lastDelivery(channel: NotificationChannel, now: number): string {
  if (channel.last_error !== null) {
    return `Last delivery failed: ${channel.last_error}`;
  }
  if (channel.last_sent_at === null) return "Never sent — never used, or nothing has changed state.";
  return `Delivered ${relativeTime(channel.last_sent_at, now)}`;
}

interface Props {
  channels: NotificationChannel[];
  now: number;
  busy: boolean;
  /**
   * The row whose test message is in flight, and how far it got. The test lives
   * in a menu now, so it has no button of its own to spin — the row reports.
   */
  test: { id: number; state: PendingState } | null;
  onTest: (channel: NotificationChannel) => void;
  onEdit: (channel: NotificationChannel) => void;
  onDelete: (channel: NotificationChannel) => void;
}

export function ChannelList({ channels, now, busy, test, onTest, onEdit, onDelete }: Props) {
  if (channels.length === 0) {
    return (
      <p className="text-muted-foreground glass rounded-xl border p-6 text-sm">
        No channels yet. Nothing is sent anywhere until you add one — the status page still records
        the outage.
      </p>
    );
  }

  return (
    <ul className="glass glass-popover divide-y rounded-xl border">
      {channels.map((channel) => (
        <li key={channel.id} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-48 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {channel.name}
              <span className="text-muted-foreground text-xs font-normal">
                {`${TYPE_LABEL[channel.type]} · ${channel.enabled === 1 ? "Enabled" : "Disabled"}`}
              </span>
            </p>
            <p className="text-muted-foreground text-xs">{lastDelivery(channel, now)}</p>
          </div>

          <Pending state={test !== null && test.id === channel.id ? test.state : "idle"} />

          <RowMenu
            label={`Actions for ${channel.name}`}
            actions={[
              { label: "Send test message", onSelect: () => onTest(channel), disabled: busy },
              { label: "Edit", onSelect: () => onEdit(channel) },
              { label: "Delete", onSelect: () => onDelete(channel), destructive: true },
            ]}
          />
        </li>
      ))}
    </ul>
  );
}
