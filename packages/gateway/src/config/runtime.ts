// The installation's default agent runtime (ADR-0042 decision 1): `DEFAULT_RUNTIME` in `.env`,
// one of the runtimes the sidecar hosts. Empty means the Claude Agent SDK, so an installation
// that never heard of the knob runs exactly as before. A bot may override it; every run freezes
// the value it ran with.

import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  DEFAULT_AGENT_RUNTIME,
  DeskmatesError,
  isAgentRuntime,
} from "@deskmates/contracts";
import type { Env } from "./env.js";

export interface RuntimeConfig {
  defaultRuntime: AgentRuntime;
}

export function readRuntimeConfig(env: Env): RuntimeConfig {
  const raw = env.DEFAULT_RUNTIME?.trim() ?? "";
  if (raw === "") return { defaultRuntime: DEFAULT_AGENT_RUNTIME };
  if (!isAgentRuntime(raw)) {
    throw new DeskmatesError(
      "validation",
      `DEFAULT_RUNTIME must be one of ${AGENT_RUNTIMES.join(", ")}`,
      { key: "DEFAULT_RUNTIME", raw },
    );
  }
  return { defaultRuntime: raw };
}
