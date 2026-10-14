// Server configuration from the environment. The token stays in memory: it is never logged,
// never written anywhere, and no error message built here contains it.

import { DeskmatesError } from "@deskmates/contracts";

/** How often `wait_task` polls the task and its runs. */
export const POLL_INTERVAL_MS_DEFAULT = 2_000;
const POLL_INTERVAL_MS_MIN = 100;

export interface AgentMcpConfig {
  /** The Gateway's operator listener, e.g. `https://deskmates.example.com`. No trailing slash. */
  gatewayUrl: string;
  /** A service principal token (`deskmates-sp.<token>`) or the operator token. */
  token: string;
  /** Used by every tool whose `workspaceId` argument is omitted. */
  defaultWorkspaceId?: string;
  pollIntervalMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value)
    throw new DeskmatesError("validation", `${key} is required in the environment`, { key });
  return value;
}

function gatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeskmatesError("validation", "DESKMATES_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new DeskmatesError("validation", "DESKMATES_URL must be http or https");
  // Credentials belong in DESKMATES_TOKEN; a URL ends up in logs and error text.
  if (url.username || url.password)
    throw new DeskmatesError("validation", "DESKMATES_URL must not carry credentials");
  return raw.replace(/\/+$/, "");
}

export function loadConfig(env: Env): AgentMcpConfig {
  const url = gatewayUrl(required(env, "DESKMATES_URL"));
  const token = required(env, "DESKMATES_TOKEN");
  const workspaceId = env.DESKMATES_WORKSPACE_ID?.trim();
  const rawPoll = env.DESKMATES_POLL_INTERVAL_MS?.trim();
  let pollIntervalMs = POLL_INTERVAL_MS_DEFAULT;
  if (rawPoll) {
    pollIntervalMs = Number.parseInt(rawPoll, 10);
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < POLL_INTERVAL_MS_MIN)
      throw new DeskmatesError(
        "validation",
        `DESKMATES_POLL_INTERVAL_MS must be an integer of at least ${POLL_INTERVAL_MS_MIN}`,
      );
  }
  return {
    gatewayUrl: url,
    token,
    ...(workspaceId ? { defaultWorkspaceId: workspaceId } : {}),
    pollIntervalMs,
  };
}
