// Published workspace apps (ADR-0035): a bot or a Member publishes a port of a service in its
// workspace; signed-in workspace Members open it on its own origin through the Gateway.

/** Whether a publication can be opened: revoked never, active only while the service answers. */
export type AppShareState = "available" | "unavailable" | "revoked";

export interface AppShare {
  id: string;
  workspaceId: string;
  /** TCP port in the workspace container, 1024 to 65535, never 6080 to 6086. */
  port: number;
  label: string;
  /** The application URL on its own origin (ADR-0035 decision 2). */
  url: string;
  /** Bot that published it, and the run it published from; null when a person published. */
  botId: string | null;
  runId: string | null;
  /** The person who published it from the UI (`user:<id>`); null for a bot's publication. */
  publishedBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /** `available`/`unavailable` from a live probe at list time; `revoked` from the row. */
  state: AppShareState;
  /** Why an active publication is unavailable: no relay on this proxy, or nothing answered. */
  reason?: "relay_missing" | "not_running" | "workspace_stopped";
}

/**
 * `POST /internal/runs/:runId/app-shares`: the bot tool's request; also the body of a person's
 * `POST /api/workspaces/:id/app-shares` (owner-decided 2026-10-14).
 */
export interface AppPublishRequest {
  port: number;
  label: string;
}

export interface AppPublishResponse {
  share: AppShare;
  /** True when this port already had an active publication, whose label was updated. */
  existing: boolean;
}

/**
 * `POST /api/workspaces/:id/app-shares/:shareId/open`: a one-use entry ticket the UI submits in a
 * form `POST` to `enterUrl`, never in a URL (ADR-0035 decision 3).
 */
export interface AppShareOpenResponse {
  enterUrl: string;
  ticket: string;
  /** Seconds the ticket stays valid. */
  expiresIn: number;
}

/** Ports a publication may name (ADR-0035 decision 1; the relay refuses the same set). */
export function appSharePortAllowed(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !(port >= 6080 && port <= 6086);
}

/** At most this many active publications per workspace (ADR-0035 decision 1). */
export const APP_SHARES_PER_WORKSPACE_MAX = 10;
export const APP_SHARE_LABEL_MAX = 80;
