// The workspace default bot (ADR-0051 decisions 1 and 5): which bot a workspace's people talk to
// first, set by an Owner or Admin and audited, and frozen on a run's row as
// `runs.config_json.workspaceAssistant` when its first process starts, so a resume keeps the
// tools it started with. Being the default bot is a routing and tooling fact, not a permission
// between bots (AGENTS.md): every bot keeps everything the shared workspace gives it.

import {
  type BotId,
  DeskmatesError,
  NOT_DEFAULT_BOT,
  type RunId,
  type WorkspaceAssistantMode,
  type WorkspaceId,
  isWorkspaceAssistantMode,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

export class DefaultBotStore {
  constructor(private readonly db: GatewayDb) {}

  /** The workspace's default bot, unless it has none or it is in Trash. */
  get(workspaceId: WorkspaceId): BotId | undefined {
    const row = this.db
      .prepare(
        `SELECT d.bot_id FROM workspace_default_bots d JOIN bots b ON b.id = d.bot_id
         WHERE d.workspace_id = ? AND b.archived_at IS NULL`,
      )
      .get(workspaceId) as { bot_id: string } | undefined;
    return row?.bot_id as BotId | undefined;
  }

  /**
   * Make `botId` the workspace's default bot, replacing the previous one; one audit row when it
   * changed, none when it did not. The bot must be an active bot of that workspace.
   */
  set(workspaceId: WorkspaceId, botId: BotId, actor: string): BotId {
    const bot = this.db
      .prepare("SELECT workspace_id, archived_at FROM bots WHERE id = ?")
      .get(botId) as { workspace_id: string; archived_at: string | null } | undefined;
    if (!bot || bot.archived_at !== null)
      throw new DeskmatesError("not_found", `bot ${botId} not found`, { botId });
    if (bot.workspace_id !== workspaceId)
      throw new DeskmatesError("validation", `bot ${botId} belongs to another workspace`, {
        botId,
        workspaceId,
      });
    const before = this.get(workspaceId);
    if (before === botId) return botId;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspace_default_bots (workspace_id, bot_id, set_by, set_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
             bot_id = excluded.bot_id, set_by = excluded.set_by, set_at = excluded.set_at`,
        )
        .run(workspaceId, botId, actor, nowIso());
      new AuditLog(this.db).record({
        action: "workspace.default_bot_set",
        actor,
        workspaceId,
        targetKind: "workspace",
        targetId: workspaceId,
        before: { defaultBotId: before ?? null },
        after: { defaultBotId: botId },
      });
    })();
    return botId;
  }

  /** What a run of this bot would freeze now (decision 5). */
  modeFor(botId: BotId, workspaceId: WorkspaceId): WorkspaceAssistantMode {
    return this.get(workspaceId) === botId ? "assistant-v1" : "off";
  }

  /**
   * Decision 5: the run's first process freezes the mode; every later process reads it back, so
   * a resume keeps what it started with whatever the default is now. A Gateway job never has
   * the tools, and a run from before ADR-0051 that is past its first start never gains them.
   */
  startMode(
    runs: Pick<RunStore, "setConfig">,
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): WorkspaceAssistantMode {
    const frozen = run.config.workspaceAssistant;
    if (isWorkspaceAssistantMode(frozen)) return frozen;
    if (run.attempt > 1 || run.status !== "queued") return "off";
    const mode: WorkspaceAssistantMode =
      run.config.runType === undefined ? this.modeFor(run.botId, workspaceId) : "off";
    runs.setConfig(run.id, { workspaceAssistant: mode });
    return mode;
  }

  /**
   * Decision 3: the internal routes answer only a run that froze `assistant-v1` and whose bot is
   * still the workspace's default bot; any other run is refused with `forbidden`.
   */
  assertAssistantRun(run: Pick<RunRecord, "id" | "botId" | "config">, workspaceId: WorkspaceId) {
    if (run.config.workspaceAssistant !== "assistant-v1" || this.get(workspaceId) !== run.botId)
      throw new DeskmatesError(
        "forbidden",
        "only a run of the workspace's default bot may create or change bots and groups",
        { reason: NOT_DEFAULT_BOT, runId: run.id as RunId },
      );
  }
}

const stores = new WeakMap<GatewayDb, DefaultBotStore>();

/**
 * The store for a Gateway database, built on first use rather than held on the context, whose
 * field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function defaultBots(ctx: { db: GatewayDb }): DefaultBotStore {
  let store = stores.get(ctx.db);
  if (!store) {
    store = new DefaultBotStore(ctx.db);
    stores.set(ctx.db, store);
  }
  return store;
}
