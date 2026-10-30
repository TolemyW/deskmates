// Reducing Socket Mode frames to what the plugin acts on. Pure functions over Slack's JSON, so the
// admission rules are testable on their own: only direct messages (`im`) from a person, for this
// connection's own team and app, become inbound messages. Channels, private channels, multi-person
// DMs, edits, deletions, bot messages (the plugin's own replies included) and everything else are
// ignored without a thread or a wake (ADR-0047: 1:1 only in this version). A reply inside a DM
// thread is refused with a notice, because threads are not implemented.

/** A file a person attached, as much as the plugin needs of Slack's file object. */
export interface SlackFileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** `url_private_download`, fetched with the bot token; absent when Slack withheld it. */
  url: string | undefined;
}

export interface SlackDirectMessage {
  /** The provider's event id (`Ev…`), the inbound idempotency key. */
  eventId: string;
  /** The DM channel id (`D…`), the conversation key. */
  channel: string;
  /** The person's user id (`U…` or `W…`). */
  user: string;
  /** Slack's message text, still in Slack markup. */
  text: string;
  ts: string;
  files: SlackFileRef[];
  /** A reply inside a thread of the DM: refused with a notice, never posted. */
  threadReply: boolean;
}

export type SlackFrame =
  | { kind: "hello"; appId: string | undefined }
  | { kind: "disconnect"; reason: string }
  | { kind: "envelope"; envelopeId: string; payload: SlackEnvelopePayload }
  | { kind: "unknown" };

export type SlackEnvelopePayload =
  | { kind: "message"; message: SlackDirectMessage; origin: SlackEventOrigin }
  | { kind: "revoked"; eventId: string; origin: SlackEventOrigin }
  | { kind: "ignored"; reason: SlackIgnoreReason; eventId: string | undefined };

export type SlackIgnoreReason =
  | "not_an_event"
  | "not_a_message"
  | "not_a_direct_message"
  | "subtype"
  | "bot_message"
  | "malformed";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function files(value: unknown): SlackFileRef[] {
  if (!Array.isArray(value)) return [];
  const out: SlackFileRef[] = [];
  for (const item of value) {
    const file = record(item);
    if (!file) continue;
    // `hidden_by_limit`, `tombstone` and Slack Connect files without access carry no bytes.
    const usable = file.mode !== "tombstone" && file.mode !== "hidden_by_limit";
    out.push({
      id: str(file.id) ?? "file",
      name: str(file.name) ?? str(file.title) ?? "file",
      mimeType: (str(file.mimetype) ?? "").toLowerCase(),
      size: typeof file.size === "number" ? file.size : 0,
      url: usable ? (str(file.url_private_download) ?? str(file.url_private)) : undefined,
    });
  }
  return out;
}

/** Which Slack workspace and organisation an event came from; the connection compares both. */
export interface SlackEventOrigin {
  teamId: string;
  enterpriseId: string;
  appId: string;
}

function originOf(payload: Record<string, unknown>): SlackEventOrigin {
  return {
    teamId: str(payload.team_id) ?? "",
    enterpriseId: str(payload.enterprise_id) ?? "",
    appId: str(payload.api_app_id) ?? "",
  };
}

function envelopePayload(frame: Record<string, unknown>, botUserId: string): SlackEnvelopePayload {
  const payload = record(frame.payload);
  if (frame.type !== "events_api" || !payload || payload.type !== "event_callback")
    return { kind: "ignored", reason: "not_an_event", eventId: undefined };
  const eventId = str(payload.event_id);
  const origin = originOf(payload);
  const event = record(payload.event);
  if (!event || !eventId) return { kind: "ignored", reason: "malformed", eventId };
  if (event.type === "app_uninstalled") return { kind: "revoked", eventId, origin };
  if (event.type === "tokens_revoked") {
    const tokens = record(event.tokens);
    const bots = Array.isArray(tokens?.bot) ? tokens.bot : [];
    return bots.includes(botUserId)
      ? { kind: "revoked", eventId, origin }
      : { kind: "ignored", reason: "not_a_message", eventId };
  }
  if (event.type !== "message") return { kind: "ignored", reason: "not_a_message", eventId };
  const channel = str(event.channel);
  if (event.channel_type !== "im" || !channel?.startsWith("D"))
    return { kind: "ignored", reason: "not_a_direct_message", eventId };
  if (event.bot_id !== undefined || event.subtype === "bot_message" || event.user === botUserId)
    return { kind: "ignored", reason: "bot_message", eventId };
  if (event.subtype !== undefined && event.subtype !== "file_share")
    return { kind: "ignored", reason: "subtype", eventId };
  const user = str(event.user);
  const ts = str(event.ts);
  if (!user || !ts) return { kind: "ignored", reason: "malformed", eventId };
  const threadTs = str(event.thread_ts);
  return {
    kind: "message",
    origin,
    message: {
      eventId,
      channel,
      user,
      text: typeof event.text === "string" ? event.text : "",
      ts,
      files: files(event.files),
      threadReply: threadTs !== undefined && threadTs !== ts,
    },
  };
}

/** Parse one WebSocket text frame. `botUserId` filters the plugin's own messages. */
export function parseSlackFrame(text: string, botUserId: string): SlackFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unknown" };
  }
  const frame = record(parsed);
  if (!frame) return { kind: "unknown" };
  if (frame.type === "hello")
    return { kind: "hello", appId: str(record(frame.connection_info)?.app_id) };
  if (frame.type === "disconnect")
    return { kind: "disconnect", reason: str(frame.reason) ?? "unknown" };
  const envelopeId = str(frame.envelope_id);
  if (envelopeId)
    return { kind: "envelope", envelopeId, payload: envelopePayload(frame, botUserId) };
  return { kind: "unknown" };
}
