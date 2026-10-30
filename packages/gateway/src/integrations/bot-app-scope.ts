// ADR-0055: the connected apps a bot's run may use. The run's first process freezes the bot's
// list (or "all") on `runs.config_json.integrationApps`; every later process and every integration
// call reads the frozen value, so a saved change reaches only the next run.

import type { BotDefinition, BotIntegrationAppsScope } from "@deskmates/contracts";
import type { RunRecord, RunStore } from "../ledger/runs.js";

/** The value a run froze, or undefined for a run from before ADR-0055 or one not started yet. */
export function frozenAppScope(
  config: Record<string, unknown>,
): BotIntegrationAppsScope | undefined {
  const value = config.integrationApps;
  if (value === "all") return "all";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
}

/** Decision 3: attempt 1 freezes the bot's list; a later process reads it back. */
export function startAppScope(
  runs: Pick<RunStore, "setConfig">,
  run: RunRecord,
  bot: Pick<BotDefinition, "integrationApps">,
): BotIntegrationAppsScope {
  const frozen = frozenAppScope(run.config);
  if (frozen !== undefined) return frozen;
  if (run.attempt > 1 || run.status !== "queued") return "all";
  const scope: BotIntegrationAppsScope = bot.integrationApps ? [...bot.integrationApps] : "all";
  runs.setConfig(run.id, { integrationApps: scope });
  return scope;
}

/** Whether a scope allows one service; absent (an older run) allows every app. */
export function appAllowed(scope: BotIntegrationAppsScope | undefined, service: string): boolean {
  return scope === undefined || scope === "all" || scope.includes(service);
}
