// Demo routes of workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2): a
// workspace starts with nothing stored and the owner's defaults (turn budget and volume rule off);
// `off` needs no budget unless the workspace requires one, as on the Gateway.

import {
  LOOP_BREAKER_BOT_MESSAGES,
  LOOP_BREAKER_RELAY_MAX,
  LOOP_BREAKER_REPEATS,
  TURN_BUDGET_DEFAULT,
  WORKSPACE_LIMIT_KEYS,
  WORKSPACE_LIMIT_RANGES,
  WORKSPACE_LIMIT_SWITCH_KEYS,
  type WorkspaceLimitKey,
  type WorkspaceLimitSettings,
  type WorkspaceLimitSwitchKey,
  type WorkspaceLimitSwitches,
  type WorkspaceLimitsView,
  workspaceLimitDefaults,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

/** The demo Gateway's `DESKMATES_MAX_TURNS`. */
const DEMO_MAX_TURNS = 80;

const OFF_SWITCHES: WorkspaceLimitSwitches = { requireBudgetForOff: false, volumeBreaker: false };

const store = (s: DemoState) =>
  s.store("limits", () => ({
    settings: {} as Record<string, WorkspaceLimitSettings>,
    switches: {} as Record<string, WorkspaceLimitSwitches>,
  }));

function view(s: DemoState, workspaceId: string): WorkspaceLimitsView {
  const settings = store(s).settings[workspaceId] ?? {};
  const switches = store(s).switches[workspaceId] ?? OFF_SWITCHES;
  const defaults = workspaceLimitDefaults(DEMO_MAX_TURNS);
  // The demo has no budget wiring of its own: a workspace that requires one has none.
  const gated = switches.requireBudgetForOff;
  const effective = Object.fromEntries(
    WORKSPACE_LIMIT_KEYS.map((key) => {
      const stored = settings[key];
      const fallback = {
        value: defaults[key] ?? TURN_BUDGET_DEFAULT,
        source: "default_no_backstop",
      };
      if (stored === undefined) {
        if (defaults[key] === null && gated) return [key, fallback];
        return [key, { value: defaults[key], source: key === "maxTurns" ? "gateway" : "default" }];
      }
      if (stored === "off") return [key, gated ? fallback : { value: null, source: "workspace" }];
      return [key, { value: stored, source: "workspace" }];
    }),
  ) as WorkspaceLimitsView["effective"];
  return {
    workspaceId,
    settings,
    switches: { ...switches },
    effective,
    defaults: { ...defaults },
    ranges: { ...WORKSPACE_LIMIT_RANGES },
    loopBreaker: {
      relayMax: LOOP_BREAKER_RELAY_MAX,
      botMessages: LOOP_BREAKER_BOT_MESSAGES,
      repeats: LOOP_BREAKER_REPEATS,
    },
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
    const switches: WorkspaceLimitSwitches = {
      ...(store(s).switches[workspaceId] ?? OFF_SWITCHES),
    };
    for (const [key, value] of Object.entries(req.body)) {
      if ((WORKSPACE_LIMIT_SWITCH_KEYS as readonly string[]).includes(key)) {
        if (typeof value === "boolean") switches[key as WorkspaceLimitSwitchKey] = value;
        continue;
      }
      if (!(WORKSPACE_LIMIT_KEYS as readonly string[]).includes(key)) continue;
      if (value === null) delete next[key as WorkspaceLimitKey];
      else if (typeof value === "number" || value === "off") next[key as WorkspaceLimitKey] = value;
    }
    store(s).settings[workspaceId] = next;
    store(s).switches[workspaceId] = switches;
    return ok({ limits: view(s, workspaceId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
