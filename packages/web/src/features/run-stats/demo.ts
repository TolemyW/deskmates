// Demo routes of the run_stats switch (ADR-0050 decision 6): off by default for every demo bot;
// turning it on is kept for the demo session only.

import type { BotId, BotRunStatsSetting } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const enabled = new WeakMap<DemoState, Set<string>>();

function setting(s: DemoState, botId: string): BotRunStatsSetting {
  return { botId: botId as BotId, enabled: enabled.get(s)?.has(botId) ?? false };
}

function route(req: DemoRequest, s: DemoState): Result | undefined {
  const match = req.match(/^\/api\/bots\/([^/]+)\/run-stats$/);
  if (!match) return undefined;
  const botId = decodeURIComponent(match[1] ?? "");
  if (!s.bots.some((b) => b.id === botId)) return notFound("bot");
  if (req.method === "GET") return ok({ runStats: setting(s, botId) });
  if (req.method === "PUT") {
    if (typeof req.body.enabled !== "boolean")
      return { status: 400, json: { code: "validation", message: "enabled must be a boolean" } };
    const set = enabled.get(s) ?? new Set<string>();
    enabled.set(s, set);
    if (req.body.enabled) set.add(botId);
    else set.delete(botId);
    return ok({ runStats: setting(s, botId) });
  }
  return undefined;
}

export const demo: DemoFeature = { route };
