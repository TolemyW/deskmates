// Native desktop tools (ADR-0048 decision 1 as rewritten by amendment 1, A1, owner answer of
// 2026-10-17 "默认开启"): on by default on a workspace image that declares `desktop-lcu-v1`, off on
// any other. A stored row is an explicit choice of an Owner or Admin, on or off, for a workspace or
// one bot; no row is the default. This module holds those choices, the image facts last read from
// the provider, the audit row, and the value a run freezes in `runs.config_json` when attempt 1
// starts. Giving a bot the tools is a strategy change (AGENTS.md): nothing here measures it. A
// workspace with the tools on is the grouping-rule exception of decision 10, which the view
// reports so the page can show it.

import {
  type BotId,
  DeskmatesError,
  type DesktopImageFacts,
  type DesktopToolsConfig,
  type DesktopToolsInput,
  type DesktopToolsMode,
  type DesktopToolsView,
  type StartRunRequest,
  type WorkspaceId,
  desktopImageFacts,
} from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayContext } from "../context.js";
import type { GatewayDb } from "../db/open.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

type Setting = DesktopToolsView["setting"];

interface WorkspaceRow {
  mode: DesktopToolsMode;
  lcu_version: string | null;
  app_version: string | null;
  is_enabled: number;
  updated_by: string;
  updated_at: string;
}

/** What the audit row records before and after a change: the explicit choices only. */
interface Snapshot {
  setting: Setting;
  /** Bots with an explicit choice, on or off; a bot not listed has the default. */
  bots: Record<string, boolean>;
}

/** The `runs.config_json` keys a run freezes (decision 1). */
export interface FrozenDesktopTools {
  desktopTools: DesktopToolsConfig;
  desktopLcuVersion?: string;
  desktopAppVersion?: string;
}

/** How long a read of the image's labels is trusted before a run start asks for a fresh one. */
export const DESKTOP_IMAGE_FACTS_MAX_AGE_MS = 5 * 60 * 1000;

/** Whether a workspace setting gives its bots the tools on an image with these facts. */
function workspaceOn(setting: Setting, image: DesktopImageFacts | undefined): boolean {
  if (setting === "off") return false;
  // An explicit on was accepted on a capable image; it holds unless the image is known not to be.
  if (setting === "on") return image?.capable !== false;
  // The default is on exactly when the image is known to be capable (fail closed when unknown).
  return image?.capable === true;
}

function imageState(image: DesktopImageFacts | undefined): DesktopToolsView["image"] {
  return image === undefined ? "unknown" : image.capable ? "capable" : "not_capable";
}

export class DesktopToolsStore {
  private image: { facts: DesktopImageFacts | undefined; readAt: number } | undefined;
  private refreshing = false;
  /** Reads the image's labels again; set by `desktopTools(ctx)` when the context has a provider. */
  refresher: (() => Promise<unknown>) | undefined;

  constructor(
    private readonly db: GatewayDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record what the configured workspace image declares now (undefined: it cannot be read). */
  noteImage(facts: DesktopImageFacts | undefined): void {
    this.image = { facts, readAt: this.now().getTime() };
  }

  /** The image facts last read; undefined when never read or unreadable. */
  imageFacts(): DesktopImageFacts | undefined {
    return this.image?.facts;
  }

  /** Ask for a fresh read when the last one is missing or old; never waits for it. */
  private refreshIfStale(): void {
    const age =
      this.image === undefined
        ? Number.POSITIVE_INFINITY
        : this.now().getTime() - this.image.readAt;
    if (age < DESKTOP_IMAGE_FACTS_MAX_AGE_MS || this.refreshing || !this.refresher) return;
    this.refreshing = true;
    void this.refresher()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = false;
      });
  }

  private row(workspaceId: WorkspaceId): WorkspaceRow | undefined {
    return this.db
      .prepare("SELECT * FROM workspace_desktop_tools WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
  }

  private setting(workspaceId: WorkspaceId): Setting {
    const row = this.row(workspaceId);
    return row === undefined ? "default" : row.is_enabled === 1 ? "on" : "off";
  }

  private botChoices(workspaceId: WorkspaceId): Record<string, boolean> {
    const rows = this.db
      .prepare(
        "SELECT bot_id, is_enabled FROM bot_desktop_tools WHERE workspace_id = ? ORDER BY bot_id",
      )
      .all(workspaceId) as { bot_id: string; is_enabled: number }[];
    return Object.fromEntries(rows.map((r) => [r.bot_id, r.is_enabled === 1]));
  }

  private snapshot(workspaceId: WorkspaceId): Snapshot {
    return { setting: this.setting(workspaceId), bots: this.botChoices(workspaceId) };
  }

  /** The workspace's state for its page; `image` is what the configured image declares now. */
  view(
    workspaceId: WorkspaceId,
    bots: readonly { id: string; name: string }[],
    image: DesktopImageFacts | undefined,
  ): DesktopToolsView {
    const row = this.row(workspaceId);
    const setting = this.setting(workspaceId);
    const enabled = workspaceOn(setting, image);
    const choices = this.botChoices(workspaceId);
    const lcuVersion = image?.lcuVersion ?? row?.lcu_version ?? undefined;
    const appVersion = image?.appVersion ?? row?.app_version ?? undefined;
    return {
      workspaceId,
      enabled,
      setting,
      ...(enabled ? { mode: "lcu-v1" as const } : {}),
      ...(enabled && lcuVersion ? { lcuVersion } : {}),
      ...(enabled && appVersion ? { appVersion } : {}),
      image: imageState(image),
      bots: bots.map((b) => {
        const choice = choices[b.id];
        const botSetting: Setting = choice === undefined ? "default" : choice ? "on" : "off";
        return {
          botId: b.id,
          name: b.name,
          enabled: enabled && choice !== false,
          setting: botSetting,
        };
      }),
      groupingException: enabled,
      ...(row ? { updatedAt: row.updated_at, updatedBy: row.updated_by } : {}),
    };
  }

  /**
   * A1: turning a workspace on explicitly needs an image that declares the capability (`image`
   * is undefined when the provider cannot tell, which refuses too); turning a bot on needs its
   * workspace not set off, and the bot must belong to it. Turning a workspace off keeps its bots'
   * choices. One audit row per call that changed something.
   */
  set(
    workspaceId: WorkspaceId,
    raw: Record<string, unknown>,
    actor: string,
    workspaceBots: ReadonlySet<string>,
    image: DesktopImageFacts | undefined,
  ): void {
    for (const key of Object.keys(raw))
      if (key !== "enabled" && key !== "bots")
        throw new DeskmatesError("validation", `unknown desktop tools setting ${key}`, { key });
    const input = raw as DesktopToolsInput;
    if ("enabled" in raw && typeof raw.enabled !== "boolean")
      throw new DeskmatesError("validation", "enabled must be a boolean");
    const botChanges: [string, boolean][] = [];
    if ("bots" in raw) {
      const bots = raw.bots;
      if (!bots || typeof bots !== "object" || Array.isArray(bots))
        throw new DeskmatesError("validation", "bots must map bot ids to booleans");
      for (const [botId, value] of Object.entries(bots as Record<string, unknown>)) {
        if (typeof value !== "boolean")
          throw new DeskmatesError("validation", "bots must map bot ids to booleans", { botId });
        if (!workspaceBots.has(botId))
          throw new DeskmatesError("validation", "bot is not in this workspace", { botId });
        botChanges.push([botId, value]);
      }
    }
    const before = this.snapshot(workspaceId);
    const setting: Setting =
      input.enabled === undefined ? before.setting : input.enabled ? "on" : "off";
    if (setting === "on" && before.setting !== "on" && image?.capable !== true)
      throw new DeskmatesError(
        "validation",
        "the workspace image does not declare the desktop-lcu-v1 capability",
        { reason: "desktop_capability_missing" },
      );
    if (setting === "off" && botChanges.some(([, on]) => on))
      throw new DeskmatesError("validation", "turn the workspace's desktop tools on first", {
        reason: "desktop_workspace_off",
      });
    const bots: Record<string, boolean> = { ...before.bots };
    for (const [botId, on] of botChanges) bots[botId] = on;
    const after: Snapshot = {
      setting,
      bots: Object.fromEntries(Object.entries(bots).sort(([a], [b]) => a.localeCompare(b))),
    };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const at = this.now().toISOString();
    this.db.transaction(() => {
      if (setting !== before.setting) {
        this.db
          .prepare(
            `INSERT INTO workspace_desktop_tools
               (workspace_id, mode, lcu_version, app_version, is_enabled, updated_by, updated_at)
             VALUES (?, 'lcu-v1', ?, ?, ?, ?, ?)
             ON CONFLICT (workspace_id) DO UPDATE SET
               lcu_version = COALESCE(excluded.lcu_version, lcu_version),
               app_version = COALESCE(excluded.app_version, app_version),
               is_enabled = excluded.is_enabled,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .run(
            workspaceId,
            setting === "on" ? (image?.lcuVersion ?? null) : null,
            setting === "on" ? (image?.appVersion ?? null) : null,
            setting === "on" ? 1 : 0,
            actor,
            at,
          );
      }
      this.db.prepare("DELETE FROM bot_desktop_tools WHERE workspace_id = ?").run(workspaceId);
      const insert = this.db.prepare(
        `INSERT INTO bot_desktop_tools (bot_id, workspace_id, is_enabled, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [botId, on] of Object.entries(after.bots))
        insert.run(botId, workspaceId, on ? 1 : 0, actor, at);
      new AuditLog(this.db).record({
        action: "workspace.desktop_tools_set",
        actor,
        workspaceId,
        targetKind: "workspace_desktop_tools",
        targetId: workspaceId,
        before,
        after,
      });
    })();
  }

  /** What the choices and the image say for this bot now. */
  effective(
    workspaceId: WorkspaceId,
    botId: BotId,
    image: DesktopImageFacts | undefined = this.imageFacts(),
  ): FrozenDesktopTools {
    const row = this.row(workspaceId);
    if (!workspaceOn(this.setting(workspaceId), image)) return { desktopTools: "off" };
    if (this.botChoices(workspaceId)[botId] === false) return { desktopTools: "off" };
    const lcuVersion = image?.lcuVersion ?? row?.lcu_version ?? undefined;
    const appVersion = image?.appVersion ?? row?.app_version ?? undefined;
    return {
      desktopTools: "lcu-v1",
      ...(lcuVersion ? { desktopLcuVersion: lcuVersion } : {}),
      ...(appVersion ? { desktopAppVersion: appVersion } : {}),
    };
  }

  /**
   * Decision 1: frozen on the run's first process and read back on every later one, so a resume
   * keeps the tools it started with whatever the choices or the image say now. A run from before
   * ADR-0048 that is already past its first start never gains them.
   */
  startFields(
    runs: Pick<RunStore, "setConfig">,
    run: RunRecord,
    workspaceId: WorkspaceId,
  ): Pick<StartRunRequest, "desktopTools"> {
    let mode = run.config.desktopTools;
    if (run.config.desktopToolsVersion !== 1) {
      if (run.attempt > 1 || run.status !== "queued") return {};
      this.refreshIfStale();
      // A Gateway job (a review, a summary, a probe) is a run of a bot with a fixed task: no tools.
      const effective: FrozenDesktopTools =
        run.config.runType === undefined
          ? this.effective(workspaceId, run.botId)
          : { desktopTools: "off" };
      runs.setConfig(run.id, { ...effective, desktopToolsVersion: 1 });
      mode = effective.desktopTools;
    }
    return mode === "lcu-v1" ? { desktopTools: "lcu-v1" } : {};
  }
}

const stores = new WeakMap<GatewayDb, DesktopToolsStore>();

type DesktopContext = Pick<GatewayContext, "db"> &
  Partial<Pick<GatewayContext, "provider" | "config">>;

/**
 * The store for a Gateway context. Built on first use rather than held on the context, whose
 * field list is a former hotspot (scripts/hotspot-budgets.test.mjs).
 */
export function desktopTools(ctx: DesktopContext): DesktopToolsStore {
  let store = stores.get(ctx.db);
  if (!store) {
    store = new DesktopToolsStore(ctx.db);
    stores.set(ctx.db, store);
  }
  if (!store.refresher && ctx.provider && ctx.config) {
    const full = { db: ctx.db, provider: ctx.provider, config: ctx.config };
    store.refresher = () => workspaceImageFacts(full);
  }
  return store;
}

/**
 * What the configured workspace image declares (decision 11), read from its labels through the
 * provider and kept by the store for run starts. Undefined when the provider cannot read labels
 * or the image is not on its daemon.
 */
export async function workspaceImageFacts(
  ctx: Pick<GatewayContext, "db" | "provider" | "config">,
): Promise<DesktopImageFacts | undefined> {
  let facts: DesktopImageFacts | undefined;
  if (ctx.provider.imageLabels) {
    try {
      facts = desktopImageFacts(await ctx.provider.imageLabels(ctx.config.workspaceImage));
    } catch {
      facts = undefined;
    }
  }
  desktopTools(ctx).noteImage(facts);
  return facts;
}

/**
 * A1: read the image facts once when the Gateway starts, so the first runs know whether the
 * image has desktop tools. Bounded: a daemon that does not answer leaves the facts unknown (the
 * default is then off) and a later run start asks again.
 */
export async function warmDesktopImageFacts(
  ctx: Pick<GatewayContext, "db" | "provider" | "config">,
  timeoutMs = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    workspaceImageFacts(ctx).catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
