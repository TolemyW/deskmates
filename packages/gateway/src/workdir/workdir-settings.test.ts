// T0: per-workspace working-directory settings (ADR-0036 decisions 1 to 3, 6 and 8): nothing
// stored by default, validation, the audit row, the freeze at first start and the other lane.

import type { BotId, BotWorkdirMode, RunId, WorkspaceId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { WorkdirSettingsStore } from "./workdir-settings.js";

const WS = "ws" as WorkspaceId;
let db: GatewayDb;
let gatewayMode: BotWorkdirMode;
let store: WorkdirSettingsStore;

function audits() {
  return db
    .prepare(
      "SELECT before_json, after_json, actor FROM audit_events WHERE action = 'workspace.workdir_set' ORDER BY seq",
    )
    .all() as { before_json: string; after_json: string; actor: string }[];
}

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
  gatewayMode = "shared";
  store = new WorkdirSettingsStore(db, () => gatewayMode);
});

describe("defaults (decisions 1 and 8)", () => {
  it("stores nothing and inherits the Gateway mode with no worktree and no lane notice", () => {
    expect(store.settings(WS)).toEqual({});
    expect(store.effective(WS)).toEqual({
      mode: "shared",
      source: "gateway",
      worktreeRepo: null,
      laneNotice: false,
    });
    gatewayMode = "per-bot";
    expect(store.effective(WS).mode).toBe("per-bot");
    expect(store.view(WS)).toMatchObject({ settings: {}, gatewayMode: "per-bot" });
    expect(store.view(WS)).not.toHaveProperty("updatedAt");
  });
});

describe("set (decisions 1 and 2)", () => {
  it("stores, audits once per change and clears with null", () => {
    store.set(WS, { mode: "per-bot", worktreeRepo: "/work/app", laneNotice: true }, "user:a");
    expect(store.effective(WS)).toEqual({
      mode: "per-bot",
      source: "workspace",
      worktreeRepo: "/work/app",
      laneNotice: true,
    });
    store.set(WS, { mode: "per-bot" }, "user:a");
    expect(audits()).toHaveLength(1);
    expect(JSON.parse(audits()[0]?.after_json ?? "{}")).toEqual({
      mode: "per-bot",
      worktreeRepo: "/work/app",
      laneNotice: true,
    });
    store.set(WS, { mode: null, worktreeRepo: null, laneNotice: null }, "user:b");
    expect(store.settings(WS)).toEqual({});
    expect(db.prepare("SELECT count(*) AS n FROM workspace_workdir_settings").get()).toEqual({
      n: 0,
    });
    expect(audits().map((a) => a.actor)).toEqual(["user:a", "user:b"]);
  });

  it("clears the repository when the mode becomes shared", () => {
    store.set(WS, { mode: "per-bot", worktreeRepo: "/work/app" }, "user:a");
    store.set(WS, { mode: "shared" }, "user:a");
    expect(store.settings(WS)).toEqual({ mode: "shared" });
  });

  it.each([
    [{ mode: "worktree" }],
    [{ worktreeRepo: "/work/app" }],
    [{ mode: "shared", worktreeRepo: "/work/app" }],
    [{ mode: "per-bot", worktreeRepo: "/work/../etc" }],
    [{ mode: "per-bot", worktreeRepo: "/work/bots/nova/app" }],
    [{ mode: "per-bot", worktreeRepo: 3 }],
    [{ laneNotice: "yes" }],
    [{ nope: true }],
  ])("refuses %j and writes nothing", (input) => {
    expect(() => store.set(WS, input, "user:a")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    expect(store.settings(WS)).toEqual({});
    expect(audits()).toEqual([]);
  });
});

describe("freeze and lane (decisions 3 and 6)", () => {
  const BOT = "bot_nova" as BotId;
  let runs: RunStore;

  beforeEach(() => {
    db.prepare(
      "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('bot_nova', 'ws', 'nova', 'dev', '2026-09-01T00:00:00.000Z')",
    ).run();
    runs = new RunStore(db);
  });

  const create = (lane: "interactive" | "background", config: Record<string, unknown> = {}) =>
    runs.create({
      botId: BOT,
      lane,
      triggerKind: lane === "background" ? "cron" : "webhook",
      triggerRef: `ref_${lane}_${Math.random()}`,
      config: { botWorkdir: "shared", ...config },
    });

  it("writes the five keys on the first start and reads them back afterwards", () => {
    store.set(WS, { mode: "per-bot", worktreeRepo: "/work/app", laneNotice: true }, "user:a");
    const run = create("interactive");
    expect(store.startFields(runs, run, WS)).toEqual({
      workdirMode: "per-bot",
      worktreeRepo: "/work/app",
    });
    const frozen = runs.mustGet(run.id);
    expect(frozen.config).toMatchObject({
      botWorkdir: "per-bot",
      botWorkdirSource: "workspace",
      worktreeRepo: "/work/app",
      laneNotice: true,
      workdirVersion: 1,
    });
    store.set(WS, { mode: null, worktreeRepo: null, laneNotice: null }, "user:a");
    expect(store.startFields(runs, frozen, WS)).toEqual({
      workdirMode: "per-bot",
      worktreeRepo: "/work/app",
    });
  });

  it("keeps a run from before ADR-0036 on its creation mode on a later process", () => {
    store.set(WS, { mode: "per-bot", worktreeRepo: "/work/app" }, "user:a");
    const run = create("interactive", { botWorkdir: "shared" });
    const parked = { ...run, status: "waiting_approval" as const, attempt: 1 };
    expect(store.startFields(runs, parked, WS)).toEqual({});
    expect(runs.mustGet(run.id).config).not.toHaveProperty("workdirVersion");
  });

  it("names the bot's live run on its other lane only when the notice is on", () => {
    const background = create("background");
    db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(
      "2026-10-14T08:00:00.000Z",
      background.id,
    );
    const quiet = create("interactive");
    expect(store.startFields(runs, quiet, WS)).toEqual({});

    store.set(WS, { laneNotice: true }, "user:a");
    const told = create("interactive");
    expect(store.startFields(runs, told, WS)).toEqual({
      otherLaneRun: {
        runId: background.id,
        lane: "background",
        triggerKind: "cron",
        startedAt: "2026-10-14T08:00:00.000Z",
      },
    });
    // A run on the same lane, or a finished one, is not the other lane.
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(background.id);
    expect(store.otherLaneRun(BOT, "interactive", told.id as RunId)).toBeUndefined();
  });
});
