// Per-workspace working-directory settings (ADR-0036 as amended by ADR-0038): stored values,
// validation, the audit row, the values a run freezes at first start and the other-lane note.
// The frozen mode decides whether the sidecar's soft write guard protects teammates' directories
// (ADR-0038 decision 2); that guard is against mistakes, not a security boundary. The platform
// prepares no git worktree (ADR-0038 decision 7): `worktreeRepo` is no longer a setting.

import {
  BOT_WORKDIR_DEFAULT,
  type BotId,
  type BotWorkdirMode,
  DeskmatesError,
  type EffectiveWorkdir,
  type OtherLaneRun,
  type RunId,
  type RunLane,
  type StartRunRequest,
  type WorkdirSettings,
  type WorkdirSettingsView,
  type WorkspaceId,
  occupiesLane,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

interface SettingsRow {
  mode: BotWorkdirMode | null;
  lane_notice: 0 | 1;
  updated_by: string;
  updated_at: string;
}

const MODES: readonly BotWorkdirMode[] = ["shared", "per-bot"];
const FIELDS = ["mode", "laneNotice"] as const;

/** Statuses in which a run holds its lane with a live sidecar (not `queued`). */
const LIVE_STATUSES = (["running", "waiting_approval_live"] as const).filter(occupiesLane);

function toSettings(row: SettingsRow | undefined): WorkdirSettings {
  if (!row) return {};
  return {
    ...(row.mode ? { mode: row.mode } : {}),
    ...(row.lane_notice === 1 ? { laneNotice: true as const } : {}),
  };
}

export class WorkdirSettingsStore {
  constructor(
    private readonly db: GatewayDb,
    /**
     * `DESKMATES_BOT_WORKDIR`, read on every call: the config may change after construction.
     * Undefined is the default, `per-bot` (ADR-0038 decision 1).
     */
    private readonly configuredMode: () => BotWorkdirMode | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private gatewayMode(): BotWorkdirMode {
    return this.configuredMode() ?? BOT_WORKDIR_DEFAULT;
  }

  private row(workspaceId: WorkspaceId): SettingsRow | undefined {
    return this.db
      .prepare("SELECT * FROM workspace_workdir_settings WHERE workspace_id = ?")
      .get(workspaceId) as SettingsRow | undefined;
  }

  settings(workspaceId: WorkspaceId): WorkdirSettings {
    return toSettings(this.row(workspaceId));
  }

  effective(workspaceId: WorkspaceId): EffectiveWorkdir {
    const stored = this.settings(workspaceId);
    return {
      mode: stored.mode ?? this.gatewayMode(),
      source: stored.mode ? "workspace" : "gateway",
      laneNotice: stored.laneNotice === true,
    };
  }

  view(workspaceId: WorkspaceId): WorkdirSettingsView {
    const row = this.row(workspaceId);
    return {
      workspaceId,
      settings: toSettings(row),
      effective: this.effective(workspaceId),
      gatewayMode: this.gatewayMode(),
      ...(row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : {}),
    };
  }

  /**
   * Decision 1: fields left out keep their value, null clears. `worktreeRepo` is an unknown
   * setting since ADR-0038 decision 7. One audit row per call that changed something, same
   * transaction.
   */
  set(workspaceId: WorkspaceId, input: Record<string, unknown>, actor: string): void {
    for (const key of Object.keys(input)) {
      if (!(FIELDS as readonly string[]).includes(key))
        throw new DeskmatesError("validation", `unknown workdir setting ${key}`, { key });
    }
    const before = this.settings(workspaceId);
    let mode = before.mode;
    let laneNotice = before.laneNotice === true;
    if ("mode" in input) {
      const value = input.mode;
      if (value === null) mode = undefined;
      else if (MODES.includes(value as BotWorkdirMode)) mode = value as BotWorkdirMode;
      else
        throw new DeskmatesError("validation", "mode must be shared, per-bot or null", { value });
    }
    if ("laneNotice" in input) {
      const value = input.laneNotice;
      if (value === true || value === false || value === null) laneNotice = value === true;
      else throw new DeskmatesError("validation", "laneNotice must be a boolean or null");
    }
    const after: WorkdirSettings = {
      ...(mode ? { mode } : {}),
      ...(laneNotice ? { laneNotice: true as const } : {}),
    };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const at = this.now().toISOString();
    this.db.transaction(() => {
      if (Object.keys(after).length === 0) {
        this.db
          .prepare("DELETE FROM workspace_workdir_settings WHERE workspace_id = ?")
          .run(workspaceId);
      } else {
        this.db
          .prepare(
            `INSERT INTO workspace_workdir_settings
               (workspace_id, mode, lane_notice, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (workspace_id) DO UPDATE SET mode = excluded.mode,
               lane_notice = excluded.lane_notice,
               updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          )
          .run(workspaceId, after.mode ?? null, after.laneNotice ? 1 : 0, actor, at);
      }
      new AuditLog(this.db).record({
        action: "workspace.workdir_set",
        actor,
        workspaceId,
        targetKind: "workspace_workdir_settings",
        targetId: workspaceId,
        before,
        after,
      });
    })();
  }

  /**
   * Decision 3: the run's settings, frozen on its first process and read back from the row on
   * every later one. A row from before ADR-0036 keeps its creation-time mode and nothing else.
   * A `worktreeRepo` an earlier version froze stays in the row as history and is not read.
   */
  freeze(
    runs: Pick<RunStore, "setConfig">,
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): EffectiveWorkdir {
    if (run.config.workdirVersion !== 1) {
      if (run.attempt > 1 || run.status !== "queued") return legacyWorkdir(run);
      const resolved = this.effective(workspaceId);
      // Without a workspace mode the Gateway knob applies as the row recorded it at creation
      // (ADR-0004 amendment 1 decision 11), not as it is configured now.
      const effective: EffectiveWorkdir =
        resolved.source === "gateway" && typeof run.config.botWorkdir === "string"
          ? { ...resolved, mode: legacyWorkdir(run).mode }
          : resolved;
      runs.setConfig(run.id, {
        botWorkdir: effective.mode,
        botWorkdirSource: effective.source,
        laneNotice: effective.laneNotice,
        workdirVersion: 1,
      });
      return effective;
    }
    return {
      mode: run.config.botWorkdir === "per-bot" ? "per-bot" : "shared",
      source: run.config.botWorkdirSource === "workspace" ? "workspace" : "gateway",
      laneNotice: run.config.laneNotice === true,
    };
  }

  /** Decision 6: the same bot's live run on its other lane, if any. */
  otherLaneRun(botId: BotId, lane: RunLane, runId: RunId): OtherLaneRun | undefined {
    const other: RunLane = lane === "interactive" ? "background" : "interactive";
    const row = this.db
      .prepare(
        `SELECT id, lane, trigger_kind, thread_id, started_at, created_at FROM runs
          WHERE bot_id = ? AND lane = ? AND status IN (${LIVE_STATUSES.map(() => "?").join(", ")})
            AND id <> ?
          ORDER BY created_at, id LIMIT 1`,
      )
      .get(botId, other, ...LIVE_STATUSES, runId) as
      | {
          id: string;
          lane: RunLane;
          trigger_kind: string;
          thread_id: string | null;
          started_at: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.id,
      lane: row.lane,
      triggerKind: row.trigger_kind,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      startedAt: row.started_at ?? row.created_at,
    };
  }

  /** The start-request fields of a run (ADR-0004 amendment 1 decision 11, ADR-0036 3 and 6). */
  startFields(
    runs: Pick<RunStore, "setConfig">,
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): Pick<StartRunRequest, "workdirMode" | "otherLaneRun"> {
    const effective = this.freeze(runs, run, workspaceId);
    const other = effective.laneNotice ? this.otherLaneRun(run.botId, run.lane, run.id) : undefined;
    return {
      ...(effective.mode === "per-bot" ? { workdirMode: "per-bot" as const } : {}),
      ...(other ? { otherLaneRun: other } : {}),
    };
  }
}

function legacyWorkdir(run: RunRecord): EffectiveWorkdir {
  return {
    mode: run.config.botWorkdir === "per-bot" ? "per-bot" : "shared",
    source: "gateway",
    laneNotice: false,
  };
}
