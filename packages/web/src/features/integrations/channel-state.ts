// What a person is told about a channel connection, from the plugin's phase. The phase vocabulary
// is provider-defined; anything unrecognised is treated as not reachable, so the page never claims
// a connection it has not seen succeed (issue #43 UI QA).

import { CHANNEL_PHASE_ARCHIVED } from "@deskmates/contracts";
import type { MessageKey } from "../../i18n/catalogs.js";

export type ChannelConnectionState =
  | "connected"
  | "qr"
  | "connecting"
  | "relink"
  | "disconnected"
  | "archived";

export function channelConnectionState(phase: string): ChannelConnectionState {
  // The Gateway's own phase for a workspace in Trash (ADR-0017 amendment 1 P6).
  if (phase === CHANNEL_PHASE_ARCHIVED) return "archived";
  if (phase === "connected") return "connected";
  if (phase === "qr") return "qr";
  if (phase === "idle" || phase === "connecting" || phase === "reconnecting") return "connecting";
  if (phase === "logged_out") return "relink";
  return "disconnected";
}

export const CHANNEL_STATE_LABELS: Readonly<Record<ChannelConnectionState, MessageKey>> = {
  connected: "integrations.channels.state.connected",
  qr: "integrations.channels.state.qr",
  connecting: "integrations.channels.state.connecting",
  relink: "integrations.channels.state.relink",
  disconnected: "integrations.channels.state.disconnected",
  archived: "integrations.channels.state.archived",
};

export const CHANNEL_STATE_TONES: Readonly<
  Record<ChannelConnectionState, "success" | "warning" | "danger" | "neutral">
> = {
  connected: "success",
  qr: "warning",
  connecting: "warning",
  relink: "danger",
  disconnected: "danger",
  archived: "neutral",
};

/** The one-line reason under a state that needs attention, or none. */
export function channelStateExplanation(
  state: ChannelConnectionState,
  method: string,
): MessageKey | undefined {
  if (state === "connecting") return "integrations.channels.explain.connecting";
  if (state === "relink")
    return method === "qr"
      ? "integrations.channels.explain.relink"
      : "integrations.channels.explain.reconnect";
  if (state === "disconnected") return "integrations.channels.explain.disconnected";
  if (state === "archived") return "integrations.channels.explain.archived";
  return undefined;
}
