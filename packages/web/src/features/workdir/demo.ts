// Demo routes of working-directory settings (ADR-0036): a workspace starts with nothing stored and
// inherits the demo Gateway's `shared` mode; the repository rules match the Gateway's.

import {
  type BotWorkdirMode,
  type WorkdirSettings,
  type WorkdirSettingsView,
  worktreeRepoProblem,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

/** The demo Gateway's `DESKMATES_BOT_WORKDIR`. */
const DEMO_GATEWAY_MODE: BotWorkdirMode = "shared";

const store = (s: DemoState) =>
  s.store("workdir", () => ({ settings: {} as Record<string, WorkdirSettings> }));

function view(s: DemoState, workspaceId: string): WorkdirSettingsView {
  const settings = store(s).settings[workspaceId] ?? {};
  return {
    workspaceId,
    settings,
    effective: {
      mode: settings.mode ?? DEMO_GATEWAY_MODE,
      source: settings.mode ? "workspace" : "gateway",
      worktreeRepo: settings.worktreeRepo ?? null,
      laneNotice: settings.laneNotice === true,
    },
    gatewayMode: DEMO_GATEWAY_MODE,
  };
}

function update(current: WorkdirSettings, body: Record<string, unknown>): WorkdirSettings | string {
  let { mode, worktreeRepo, laneNotice } = current;
  if ("mode" in body) {
    if (body.mode === null) mode = undefined;
    else if (body.mode === "shared" || body.mode === "per-bot") mode = body.mode;
    else return "mode must be shared, per-bot or null";
    if (mode !== "per-bot") worktreeRepo = undefined;
  }
  if ("worktreeRepo" in body) {
    if (body.worktreeRepo === null) worktreeRepo = undefined;
    else if (typeof body.worktreeRepo !== "string") return "worktreeRepo must be a string";
    else {
      const problem = worktreeRepoProblem(body.worktreeRepo);
      if (problem) return problem;
      worktreeRepo = body.worktreeRepo;
    }
  }
  if ("laneNotice" in body) laneNotice = body.laneNotice === true ? true : undefined;
  if (worktreeRepo && mode !== "per-bot")
    return "a worktree repository needs the workspace's mode set to per-bot";
  return {
    ...(mode ? { mode } : {}),
    ...(worktreeRepo ? { worktreeRepo } : {}),
    ...(laneNotice ? { laneNotice } : {}),
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/workdir$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  if (req.method === "GET") return ok({ workdir: view(s, workspaceId) });
  if (req.method === "PUT") {
    const next = update(store(s).settings[workspaceId] ?? {}, req.body);
    if (typeof next === "string")
      return { status: 400, json: { code: "validation", message: next, details: {} } };
    store(s).settings[workspaceId] = next;
    return ok({ workdir: view(s, workspaceId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
