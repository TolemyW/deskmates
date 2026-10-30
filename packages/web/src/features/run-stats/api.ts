// The bot's own read-only `run_stats` tool (ADR-0050 decision 6): read the per-bot switch, and
// set it (Owner or Admin). Off by default; runs already started keep what they froze.

import type { BotRunStatsSetting } from "@deskmates/contracts";
import type { HttpTransport } from "../../platform/http-transport.js";

export interface RunStatsApi {
  getBotRunStats(botId: string): Promise<BotRunStatsSetting>;
  setBotRunStats(botId: string, enabled: boolean): Promise<BotRunStatsSetting>;
}

export function createRunStatsApi(t: HttpTransport): RunStatsApi {
  const path = (id: string) => `/api/bots/${encodeURIComponent(id)}/run-stats`;
  return {
    async getBotRunStats(botId) {
      return (await t.json<{ runStats: BotRunStatsSetting }>("GET", path(botId))).runStats;
    },
    async setBotRunStats(botId, enabled) {
      return (await t.json<{ runStats: BotRunStatsSetting }>("PUT", path(botId), { enabled }))
        .runStats;
    },
  };
}
