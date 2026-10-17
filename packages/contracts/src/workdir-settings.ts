// Per-workspace working-directory settings (ADR-0036 as amended by ADR-0038): where a bot's runs
// start and whether a run is told about its bot's other live lane. Nothing is stored by default
// and an absent setting inherits; the Gateway default mode is `per-bot` (ADR-0038 decision 1).
// The platform prepares no git worktree: each bot clones its own code (ADR-0038 decision 7).
// The mode decides whether the sidecar's soft write guard protects teammates' directories; that
// guard is a guard against mistakes, not a security boundary.

import type { BotWorkdirMode } from "./sidecar-protocol.js";

/** The Gateway's working-directory mode when `DESKMATES_BOT_WORKDIR` is unset (ADR-0038 decision 1). */
export const BOT_WORKDIR_DEFAULT: BotWorkdirMode = "per-bot";

/** What a workspace stores; an absent field inherits (ADR-0036 decision 1). */
export interface WorkdirSettings {
  mode?: BotWorkdirMode;
  laneNotice?: true;
}

/** The values a run of this workspace freezes at its first start (ADR-0036 decision 3). */
export interface EffectiveWorkdir {
  mode: BotWorkdirMode;
  /** `workspace` when the workspace stores a mode, else the Gateway's `DESKMATES_BOT_WORKDIR`. */
  source: "workspace" | "gateway";
  laneNotice: boolean;
}

/** `GET /api/workspaces/:id/workdir`. */
export interface WorkdirSettingsView {
  workspaceId: string;
  settings: WorkdirSettings;
  effective: EffectiveWorkdir;
  /** The Gateway-wide default a workspace without a stored mode inherits. */
  gatewayMode: BotWorkdirMode;
  updatedAt?: string;
  updatedBy?: string;
}

/** `PUT /api/workspaces/:id/workdir`: a field set to null clears it; an absent field is kept. */
export interface WorkdirSettingsInput {
  mode?: BotWorkdirMode | null;
  laneNotice?: boolean | null;
}
