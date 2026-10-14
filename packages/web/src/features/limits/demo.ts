// Demo routes of workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): a
// workspace starts with nothing stored and the defaults; `off` needs a budget, as on the Gateway.

import {
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  LOOP_BREAKER_REPEATS,
  WORKSPACE_LIMIT_KEYS,
  WORKSPACE_LIMIT_RANGES,
  type WorkspaceLimitKey,
  type WorkspaceLimitSettings,
  type WorkspaceLimitsView,
  workspaceLimitDefaults,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

/** The demo Gateway's `DESKMATES_MAX_TURNS`. */
const DEMO_MAX_TURNS = 80;

const store = (s: DemoState) =>
  s.store("limits", () => ({ settings: {} as Record<string, WorkspaceLimitSettings> }));

function view(s: DemoState, workspaceId: string): WorkspaceLimitsView {
  const settings = store(s).settings[workspaceId] ?? {};
  const defaults = workspaceLimitDefaults(DEMO_MAX_TURNS);
  const effective = Object.fromEntries(
    WORKSPACE_LIMIT_KEYS.map((key) => {
      const stored = settings[key];
      if (stored === undefined)
        return [key, { value: defaults[key], source: key === "maxTurns" ? "gateway" : "default" }];
      return [key, { value: stored === "off" ? null : stored, source: "workspace" }];
    }),
  ) as WorkspaceLimitsView["effective"];
  return {
    workspaceId,
    settings,
    effective,
    defaults: { ...defaults },
    ranges: { ...WORKSPACE_LIMIT_RANGES },
    loopBreaker: {
      relayMax: LOOP_BREAKER_RELAY_MAX,
      botMessages: LOOP_BREAKER_BOT_MESSAGES,
      repeats: LOOP_BREAKER_REPEATS,
    },
    // The demo has no budget wiring of its own; `off` stays unavailable, as on a new workspace.
    budgetBackstop: false,
  };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/workspaces\/([^/]+)\/limits$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1] ?? "");
  if (!s.workspaces.some((w) => w.id === workspaceId)) return notFound("workspace");
  if (req.method === "GET") return ok({ limits: view(s, workspaceId) });
  if (req.method === "PUT") {
    const next: WorkspaceLimitSettings = { ...(store(s).settings[workspaceId] ?? {}) };
    for (const [key, value] of Object.entries(req.body)) {
      if (!(WORKSPACE_LIMIT_KEYS as readonly string[]).includes(key)) continue;
      if (value === null) delete next[key as WorkspaceLimitKey];
      else if (typeof value === "number") next[key as WorkspaceLimitKey] = value;
    }
    store(s).settings[workspaceId] = next;
    return ok({ limits: view(s, workspaceId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
