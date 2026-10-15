// Per-workspace working-directory settings (ADR-0036): where a bot's runs start, the one git
// repository the platform prepares a worktree of for each bot, and whether a run is told about
// its bot's other live lane. A convention and tooling, never access control between bots: no
// hook reads these. Nothing is stored by default and an absent setting inherits.

import type { BotWorkdirMode } from "./sidecar-protocol.js";

/** What a workspace stores; an absent field inherits (decision 1). */
export interface WorkdirSettings {
  mode?: BotWorkdirMode;
  worktreeRepo?: string;
  laneNotice?: true;
}

/** The values a run of this workspace freezes at its first start (decision 3). */
export interface EffectiveWorkdir {
  mode: BotWorkdirMode;
  /** `workspace` when the workspace stores a mode, else the Gateway's `DESKMATES_BOT_WORKDIR`. */
  source: "workspace" | "gateway";
  worktreeRepo: string | null;
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
  worktreeRepo?: string | null;
  laneNotice?: boolean | null;
}

export const WORKTREE_REPO_MAX_LENGTH = 200;

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Decision 2: why `path` cannot be a worktree repository, or undefined when it can. Shared by the
 * Gateway (when it is set) and the sidecar (when it parses a start request).
 */
export function worktreeRepoProblem(path: string): string | undefined {
  if (path.length > WORKTREE_REPO_MAX_LENGTH)
    return `worktreeRepo must be at most ${WORKTREE_REPO_MAX_LENGTH} characters`;
  if (!path.startsWith("/work/")) return "worktreeRepo must be an absolute path under /work";
  const segments = path.slice("/work/".length).split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || !SEGMENT.test(s)))
    return "worktreeRepo segments may hold only letters, digits, '.', '_' and '-'";
  if (segments[0] === "bots") return "worktreeRepo must not be under /work/bots";
  return undefined;
}

/** Decision 4: the branch the platform keeps for a bot in the worktree repository. */
export function botWorktreeBranch(botName: string): string {
  return `bots/${botName}`;
}

/** Decision 4: where a bot's worktree of `repo` lives, inside its own directory. */
export function botWorktreePath(botName: string, repo: string): string {
  return `/work/bots/${botName}/${repo.slice(repo.lastIndexOf("/") + 1)}`;
}
