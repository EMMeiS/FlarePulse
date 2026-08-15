import type { Monitor, MonitorStatus, NotificationChannel } from "./db";
import {
  createIncident,
  enabledChannels,
  getSettings,
  markChannelDelivery,
  openAutoIncidentFor,
  resolveIncident,
} from "./db";

/**
 * Notification decisions live here: which state changes are news, what a message
 * says about them, and what HTTP request each channel type wants. Everything in
 * this half is pure — `dispatchTransitions` below it is the only part that
 * touches a binding.
 */

/** The direction a monitor moved. There is no third kind of news. */
export type Transition = "up" | "down";

export interface AlertEvent {
  monitor: string;
  to: Transition;
  /** The check's own message: "HTTP 503", a DNS error, null on success. */
  message: string | null;
  /** Seconds the outage lasted, on a recovery that had an incident to close. */
  downFor?: number | null;
}

export interface AlertMessage {
  site: string;
  text: string;
  events: AlertEvent[];
}

/**
 * Two statuses in, news or silence out. It takes the statuses rather than the
 * monitor so `checker.ts` stays the only place that decides what "down" means:
 * inside the retry window the status has not moved, so neither has this.
 *
 * `pending → up` is deliberately not news. Nobody was told the new monitor was
 * broken, so nobody needs to hear that it isn't.
 */
export function transitionOf(before: MonitorStatus, after: MonitorStatus): Transition | null {
  if (before === after) return null;
  if (after === "down") return "down";
  if (after === "up" && before === "down") return "up";
  return null;
}

function eventLine(event: AlertEvent): string {
  const detail =
    event.to === "up" && event.downFor != null
      ? `down for ${humanDuration(event.downFor)}`
      : event.message;
  const head = `${event.to.toUpperCase()}: ${event.monitor}`;
  return detail ? `${head} — ${detail}` : head;
}

/**
 * One message covering every transition in this tick. The count leads when
 * there is more than one, so a reader is never misled about how much of their
 * infrastructure just moved.
 */
export function summarise(site: string, events: AlertEvent[]): string {
  const lines = events.map(eventLine);
  if (events.length === 1) return `[${site}] ${lines[0]}`;
  return [`[${site}] ${events.length} monitors changed state`, ...lines].join("\n");
}

/** Vendor ceilings, verified against their docs. */
const DISCORD_LIMIT = 2_000;
const TELEGRAM_LIMIT = 4_096;

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export interface ChannelRequest {
  url: string;
  init: RequestInit;
}

function post(url: string, body: unknown): ChannelRequest {
  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

/**
 * The three request shapes. A row missing the credential its type needs throws:
 * the table's `CHECK` makes that unreachable, and the caller already records a
 * per-channel error, so there is nothing to defend against here.
 */
export function channelRequest(
  channel: NotificationChannel,
  message: AlertMessage,
): ChannelRequest {
  switch (channel.type) {
    case "discord": {
      if (!channel.url) throw new Error(`channel ${channel.id} has no url`);
      return post(channel.url, { content: clip(message.text, DISCORD_LIMIT) });
    }
    case "telegram": {
      if (!channel.bot_token || !channel.chat_id) {
        throw new Error(`channel ${channel.id} has no bot_token or chat_id`);
      }
      return post(`https://api.telegram.org/bot${channel.bot_token}/sendMessage`, {
        chat_id: channel.chat_id,
        text: clip(message.text, TELEGRAM_LIMIT),
      });
    }
    case "webhook": {
      if (!channel.url) throw new Error(`channel ${channel.id} has no url`);
      // A webhook receiver is a program, so it gets the events too rather than
      // having to parse prose back out of `text`.
      return post(channel.url, { site: message.site, text: message.text, events: message.events });
    }
  }
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return "less than a minute";

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  const rest = minutes % 60;
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** What the checker hands over: the monitor that moved, and where it moved to. */
export interface MonitorTransition {
  monitor: Monitor;
  to: Transition;
  message: string | null;
}

/**
 * The incident half of the policy, per transition. The incident is the status
 * page's own record, so it is opened even when every channel is disabled — and
 * the title carries the monitor's name only, because the page it renders on
 * already says whose status page it is.
 *
 * Returns the outage length when there was an incident to close, which is the
 * one fact the recovery message wants that the transition itself does not carry.
 */
async function applyIncidentPolicy(
  env: Env,
  { monitor, to, message }: MonitorTransition,
  settings: { auto_open_incidents: number; auto_resolve_incidents: number },
  now: number,
): Promise<number | null> {
  if (to === "down") {
    if (!settings.auto_open_incidents) return null;
    // A flap with auto-resolve off would otherwise pile up incidents.
    if (await openAutoIncidentFor(env.DB, monitor.id)) return null;

    await createIncident(
      env.DB,
      { monitor_id: monitor.id, title: `${monitor.name} is down`, body: message, auto: 1 },
      now,
    );
    return null;
  }

  const incident = await openAutoIncidentFor(env.DB, monitor.id);
  if (!incident) return null;

  const downFor = now - incident.started_at;
  if (settings.auto_resolve_incidents) {
    await resolveIncident(env.DB, incident.id, `Recovered after ${humanDuration(downFor)}.`, now);
  }
  return downFor;
}

/**
 * One tick's worth of news: the incident policy, then **one** request per
 * enabled channel carrying every transition.
 *
 * Batching is not a nicety. Twenty monitors flipping at once with three channels
 * configured would be 60 external subrequests against a Free-plan ceiling of 50,
 * and "3 monitors are down" is also the message a human wants at 3am.
 *
 * A failing channel cannot fail a tick: each delivery is caught on its own and
 * recorded on its row, which is the only place a lost alert becomes visible.
 */
export async function dispatchTransitions(
  env: Env,
  transitions: MonitorTransition[],
  now: number,
): Promise<void> {
  if (transitions.length === 0) return;

  const settings = await getSettings(env.DB);

  const events: AlertEvent[] = [];
  for (const transition of transitions) {
    const downFor = await applyIncidentPolicy(env, transition, settings, now);
    events.push({
      monitor: transition.monitor.name,
      to: transition.to,
      message: transition.message,
      downFor,
    });
  }

  const channels = await enabledChannels(env.DB);
  if (channels.length === 0) return;

  const message: AlertMessage = {
    site: settings.site_name,
    text: summarise(settings.site_name, events),
    events,
  };

  await Promise.all(channels.map((channel) => deliver(env, channel, message, now)));
}

/** One channel, one request, one recorded result. Never throws. */
export async function deliver(
  env: Env,
  channel: NotificationChannel,
  message: AlertMessage,
  now: number,
): Promise<string | null> {
  let error: string | null = null;

  try {
    const { url, init } = channelRequest(channel, message);
    const response = await fetch(url, init);
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }

  await markChannelDelivery(env.DB, channel.id, now, error);
  return error;
}
