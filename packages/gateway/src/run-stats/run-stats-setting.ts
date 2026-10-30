// The per-bot `run_stats` setting (ADR-0050 decisions 6 and 7): off unless an Owner or Admin
// turns it on, audited on every change, and frozen in `runs.config_json.runStats` when a run's
// first process starts. Giving a bot the tool is a strategy change (AGENTS.md, decision 8):
// nothing here measures it and nothing turns it on by default.

import {
  type BotDefinition,
  type BotId,
  type BotRunStatsSetting,
  type RunStatsMode,
  type WorkspaceId,
  isRunStatsMode,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

interface SettingRow {
  bot_id: string;
  updated_by: string;
  updated_at: string;
}

export class RunStatsSettingStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private row(botId: string): SettingRow | undefined {
    return this.db
      .prepare("SELECT bot_id, updated_by, updated_at FROM bot_run_stats WHERE bot_id = ?")
      .get(botId) as SettingRow | undefined;
  }

  get(botId: BotId): BotRunStatsSetting {
    const row = this.row(botId);
    return row
      ? { botId, enabled: true, updatedAt: row.updated_at, updatedBy: row.updated_by }
      : { botId, enabled: false };
  }

  /** On or off for one bot; one audit row when the setting changed, none when it did not. */
  set(bot: Pick<BotDefinition, "id" | "workspaceId">, enabled: boolean, actor: string) {
    const before = this.row(bot.id) !== undefined;
    if (before === enabled) return this.get(bot.id);
    this.db.transaction(() => {
      if (enabled)
        this.db
          .prepare(
            `INSERT INTO bot_run_stats (bot_id, workspace_id, mode, updated_by, updated_at)
             VALUES (?, ?, 'self-v1', ?, ?)`,
          )
          .run(bot.id, bot.workspaceId, actor, this.now().toISOString());
      else this.db.prepare("DELETE FROM bot_run_stats WHERE bot_id = ?").run(bot.id);
      new AuditLog(this.db).record({
        action: "bot.run_stats_set",
        actor,
        workspaceId: bot.workspaceId,
        targetKind: "bot",
        targetId: bot.id,
        before: { enabled: before },
        after: { enabled },
      });
    })();
    return this.get(bot.id);
  }

  /** What a run of this bot would freeze now. */
  modeFor(botId: BotId, workspaceId: WorkspaceId): RunStatsMode {
    const row = this.db
      .prepare("SELECT 1 FROM bot_run_stats WHERE bot_id = ? AND workspace_id = ?")
      .get(botId, workspaceId);
    return row ? "self-v1" : "off";
  }

  /**
   * Decision 7: the run's first process freezes the mode; every later process reads it back, so
   * a resume keeps what it started with whatever the setting says now. A Gateway job never has
   * the tool, and a run from before ADR-0050 that is past its first start never gains it.
   * Returns the mode this process runs with; `self-v1` offers the tool.
   */
  startMode(
    runs: Pick<RunStore, "setConfig">,
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): RunStatsMode {
    const frozen = run.config.runStats;
    if (isRunStatsMode(frozen)) return frozen;
    if (run.attempt > 1 || run.status !== "queued") return "off";
    const mode: RunStatsMode =
      run.config.runType === undefined ? this.modeFor(run.botId, workspaceId) : "off";
    runs.setConfig(run.id, { runStats: mode });
    return mode;
  }
}

const stores = new WeakMap<GatewayDb, RunStatsSettingStore>();

/**
 * The store for a Gateway database, built on first use rather than held on the context, whose
 * field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function runStatsSettings(ctx: { db: GatewayDb }): RunStatsSettingStore {
  let store = stores.get(ctx.db);
  if (!store) {
    store = new RunStatsSettingStore(ctx.db);
    stores.set(ctx.db, store);
  }
  return store;
}

/** Whether a run froze the tool on (decision 7); what the internal route checks. */
export function runStatsFrozenOn(run: Pick<RunRecord, "config">): boolean {
  return run.config.runStats === "self-v1";
}
