import type { BotId, WorkspaceId } from "./ids.js";

export interface BotScreen {
  botId: BotId;
  workspaceId: WorkspaceId;
  slot?: number;
  state: "stopped" | "ready" | "legacy" | "unavailable";
  /** Shared desktop input means human takeover still holds the workspace browser. */
  humanHeld: boolean;
}
/**
 * A one-use ticket for one desktop WebSocket through the Gateway's screen proxy. It carries no
 * VNC password: the proxy authenticates to the workspace itself and offers the browser no
 * authentication (ADR-0022 amendment 1, C7).
 */
export interface ScreenAccess {
  accessId: string;
  path: string;
  protocol: string;
  mode: "view" | "control";
}
