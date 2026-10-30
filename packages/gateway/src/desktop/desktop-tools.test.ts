// T1 (ADR-0048 decision 1 as rewritten by amendment 1, A1): the desktop tool settings. On by
// default on an image that declares the capability, off on any other or when the image cannot be
// read; an explicit workspace or bot off wins; turning a workspace on needs a capable image and a
// bot on needs its workspace not off; turning a workspace off keeps its bots' choices; every
// change is audited once; the migration keeps an earlier choice; a run freezes the value on its
// first start and keeps it on resume whatever the settings or the image say later.

import { readFileSync, readdirSync } from "node:fs";
import type { BotId, DesktopImageFacts, WorkspaceId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { RunStore } from "../ledger/runs.js";
import { DESKTOP_IMAGE_FACTS_MAX_AGE_MS, DesktopToolsStore } from "./desktop-tools.js";

const WS = "ws" as WorkspaceId;
const BOT = "bot_nova" as BotId;
const OTHER = "bot_vega" as BotId;
const BOTS = new Set<string>([BOT, OTHER]);
const CAPABLE: DesktopImageFacts = {
  capable: true,
  lcuVersion: "0.11.3",
  appVersion: "26.915.31945",
};
const PLAIN: DesktopImageFacts = { capable: false };

let db: GatewayDb;
let store: DesktopToolsStore;
let runs: RunStore;
let clock: Date;

const audits = () =>
  db
    .prepare(
      "SELECT before_json, after_json FROM audit_events WHERE action = 'workspace.desktop_tools_set' ORDER BY seq",
    )
    .all() as { before_json: string; after_json: string }[];

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('ws', 'tnt_default', 'Ops', 'docker', 'ready', '2026-09-01T00:00:00.000Z')",
  ).run();
  for (const [id, name] of [
    [BOT, "nova"],
    [OTHER, "vega"],
  ])
    db.prepare(
      "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES (?, 'ws', ?, 'dev', '2026-09-01T00:00:00.000Z')",
    ).run(id, name);
  clock = new Date("2026-10-17T10:00:00Z");
  store = new DesktopToolsStore(db, () => clock);
  runs = new RunStore(db);
});

const bots = [
  { id: BOT, name: "nova" },
  { id: OTHER, name: "vega" },
];

describe("desktop tool settings (ADR-0048 decision 1, amendment 1 A1)", () => {
  it("are on by default on a capable image, with the grouping exception", () => {
    expect(store.view(WS, bots, CAPABLE)).toEqual({
      workspaceId: WS,
      enabled: true,
      setting: "default",
      mode: "lcu-v1",
      lcuVersion: "0.11.3",
      appVersion: "26.915.31945",
      image: "capable",
      bots: [
        { botId: BOT, name: "nova", enabled: true, setting: "default" },
        { botId: OTHER, name: "vega", enabled: true, setting: "default" },
      ],
      groupingException: true,
    });
    expect(store.effective(WS, BOT, CAPABLE)).toEqual({
      desktopTools: "lcu-v1",
      desktopLcuVersion: "0.11.3",
      desktopAppVersion: "26.915.31945",
    });
  });

  it("are off on an image without the capability and while the image cannot be read", () => {
    for (const image of [PLAIN, undefined]) {
      expect(store.view(WS, bots, image)).toMatchObject({
        enabled: false,
        setting: "default",
        groupingException: false,
        image: image ? "not_capable" : "unknown",
      });
      expect(store.effective(WS, BOT, image)).toEqual({ desktopTools: "off" });
    }
    // Nothing read yet: the cached facts are unknown, so the default is off (fail closed).
    expect(store.effective(WS, BOT)).toEqual({ desktopTools: "off" });
    store.noteImage(CAPABLE);
    expect(store.effective(WS, BOT).desktopTools).toBe("lcu-v1");
  });

  it("refuse to turn on explicitly on an image without the capability, or when it cannot be read", () => {
    for (const image of [PLAIN, undefined])
      expect(() => store.set(WS, { enabled: true }, "user:a", BOTS, image)).toThrow(
        /desktop-lcu-v1/,
      );
    expect(audits()).toEqual([]);
  });

  it("turn off per bot and per workspace, explicit choices winning, audited once per change", () => {
    store.set(WS, { bots: { [BOT]: false } }, "user:a", BOTS, CAPABLE);
    store.set(WS, { bots: { [BOT]: false } }, "user:a", BOTS, CAPABLE);
    expect(store.effective(WS, BOT, CAPABLE)).toEqual({ desktopTools: "off" });
    expect(store.effective(WS, OTHER, CAPABLE).desktopTools).toBe("lcu-v1");
    expect(store.view(WS, bots, CAPABLE).bots).toEqual([
      { botId: BOT, name: "nova", enabled: false, setting: "off" },
      { botId: OTHER, name: "vega", enabled: true, setting: "default" },
    ]);

    store.set(WS, { enabled: false }, "user:b", BOTS, CAPABLE);
    expect(store.effective(WS, OTHER, CAPABLE)).toEqual({ desktopTools: "off" });
    expect(store.view(WS, bots, CAPABLE)).toMatchObject({
      enabled: false,
      setting: "off",
      groupingException: false,
      updatedBy: "user:b",
    });

    // Turning the workspace back on keeps the bot's own off.
    store.set(WS, { enabled: true }, "user:a", BOTS, CAPABLE);
    expect(store.effective(WS, BOT, CAPABLE)).toEqual({ desktopTools: "off" });
    expect(store.effective(WS, OTHER, CAPABLE).desktopTools).toBe("lcu-v1");
    expect(audits().map((a) => JSON.parse(a.after_json))).toEqual([
      { setting: "default", bots: { [BOT]: false } },
      { setting: "off", bots: { [BOT]: false } },
      { setting: "on", bots: { [BOT]: false } },
    ]);
    // An explicit on does not survive an image that lost the capability.
    expect(store.effective(WS, OTHER, PLAIN)).toEqual({ desktopTools: "off" });
  });

  it("refuse a bot outside the workspace, a bot on in a workspace that is off, and unknown keys", () => {
    store.set(WS, { enabled: false }, "user:a", BOTS, CAPABLE);
    expect(() => store.set(WS, { bots: { [BOT]: true } }, "user:a", BOTS, CAPABLE)).toThrow(
      /on first/,
    );
    expect(() =>
      store.set(WS, { bots: { bot_elsewhere: false } }, "user:a", BOTS, CAPABLE),
    ).toThrow(/not in this workspace/);
    expect(() => store.set(WS, { image: "x" }, "user:a", BOTS, CAPABLE)).toThrow(/unknown/);
    expect(() => store.set(WS, { enabled: "yes" }, "user:a", BOTS, CAPABLE)).toThrow(/boolean/);
  });

  it("ask the provider again at a run start once the facts are old, without waiting", async () => {
    let reads = 0;
    store.refresher = async () => {
      reads += 1;
      store.noteImage(CAPABLE);
    };
    store.noteImage(undefined);
    const run = runs.create({
      botId: BOT,
      lane: "interactive",
      triggerKind: "webhook",
      triggerRef: "ref_stale",
      config: {},
    });
    expect(store.startFields(runs, run, WS)).toEqual({});
    expect(reads).toBe(0);
    clock = new Date(clock.getTime() + DESKTOP_IMAGE_FACTS_MAX_AGE_MS + 1);
    const later = runs.create({
      botId: BOT,
      lane: "interactive",
      triggerKind: "webhook",
      triggerRef: "ref_later",
      config: {},
    });
    store.startFields(runs, later, WS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    expect(store.effective(WS, BOT).desktopTools).toBe("lcu-v1");
  });
});

describe("the migration to on by default (ADR-0048 amendment 1, A1)", () => {
  it("keeps a bot that was off under the earlier rule off", () => {
    // Replay the migration's back-fill on a database in the earlier state: an enabled workspace,
    // one bot with a row (on), one without (off under the earlier rule).
    db.prepare(
      "INSERT INTO workspace_desktop_tools (workspace_id, mode, updated_by, updated_at) VALUES ('ws', 'lcu-v1', 'user:a', '2026-10-17T09:00:00.000Z')",
    ).run();
    db.prepare(
      "INSERT INTO bot_desktop_tools (bot_id, workspace_id, updated_by, updated_at) VALUES (?, 'ws', 'user:a', '2026-10-17T09:00:00.000Z')",
    ).run(BOT);
    const migration = readMigration();
    const backfill = migration.slice(migration.indexOf("INSERT INTO bot_desktop_tools"));
    db.exec(backfill.slice(0, backfill.indexOf(";") + 1));
    expect(store.view(WS, bots, CAPABLE)).toMatchObject({
      setting: "on",
      bots: [
        { botId: BOT, enabled: true, setting: "on" },
        { botId: OTHER, enabled: false, setting: "off" },
      ],
    });
  });
});

function readMigration(): string {
  const dir = new URL("../../migrations/", import.meta.url);
  const name = readdirSync(dir).find((file) => file.endsWith("-desktop-tools-default-on.sql"));
  if (!name) throw new Error("migration missing");
  return readFileSync(new URL(name, dir), "utf8");
}

describe("the run freeze (ADR-0048 decision 1)", () => {
  const create = (config: Record<string, unknown> = {}) =>
    runs.create({
      botId: BOT,
      lane: "interactive",
      triggerKind: "webhook",
      triggerRef: `ref_${Math.random()}`,
      config,
    });

  it("freezes lcu-v1 by default on attempt 1 and keeps it on resume after the switch goes off", () => {
    store.noteImage(CAPABLE);
    const run = create();
    expect(store.startFields(runs, run, WS)).toEqual({ desktopTools: "lcu-v1" });
    const frozen = runs.mustGet(run.id);
    expect(frozen.config).toMatchObject({
      desktopTools: "lcu-v1",
      desktopLcuVersion: "0.11.3",
      desktopAppVersion: "26.915.31945",
      desktopToolsVersion: 1,
    });
    store.set(WS, { enabled: false }, "user:a", BOTS, undefined);
    store.noteImage(PLAIN);
    const resumed = { ...frozen, status: "waiting_approval" as const, attempt: 2 };
    expect(store.startFields(runs, resumed, WS)).toEqual({ desktopTools: "lcu-v1" });
  });

  it("freezes off for a bot turned off and for a Gateway job, and gives an old run none", () => {
    store.noteImage(CAPABLE);
    store.set(WS, { bots: { [BOT]: false } }, "user:a", BOTS, CAPABLE);
    const off = create();
    expect(store.startFields(runs, off, WS)).toEqual({});
    expect(runs.mustGet(off.id).config).toMatchObject({
      desktopTools: "off",
      desktopToolsVersion: 1,
    });

    store.set(WS, { bots: { [BOT]: true } }, "user:a", BOTS, CAPABLE);
    const job = create({ runType: "approval_review" });
    expect(store.startFields(runs, job, WS)).toEqual({});
    expect(runs.mustGet(job.id).config.desktopTools).toBe("off");

    const old = { ...create(), status: "waiting_approval" as const, attempt: 2 };
    expect(store.startFields(runs, old, WS)).toEqual({});
    expect(runs.mustGet(old.id).config).not.toHaveProperty("desktopToolsVersion");
  });
});
