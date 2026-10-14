import { HUMAN_HOLDS_BROWSER_MESSAGE, type RunId, type WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { BrowserLockStore, TAB_HELD_BY_RUN_MESSAGE } from "./browser-lock.js";

function setup(clock: () => Date) {
  const db = openDatabase(":memory:");
  db.exec(
    "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('w', 'tnt_default','w','docker','ready','t');" +
      "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','b','r','w','t');" +
      "INSERT INTO runs (workspace_id, id,bot_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES ('w', 'r1','b','interactive','thread_message','m','running','t');" +
      "INSERT INTO runs (workspace_id, id,bot_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES ('w', 'r2','b','background','thread_message','m','running','t')",
  );
  return { db, locks: new BrowserLockStore(db, 60, clock) };
}

const ws = "w" as WorkspaceId;
const r1 = "r1" as RunId;
const r2 = "r2" as RunId;

describe("browser lock v1 (ADR-0004; test strategy §4.2 T0 browser lock)", () => {
  it("grants distinct tabs concurrently and exposes their identities", () => {
    const { locks } = setup(() => new Date("2026-09-21T10:00:00Z"));
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" }).granted,
    ).toBe(true);
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "b" }).granted,
    ).toBe(true);
    expect(locks.list(ws).map(({ holderRunId, tabId }) => ({ holderRunId, tabId }))).toEqual([
      { holderRunId: r1, tabId: "a" },
      { holderRunId: r2, tabId: "b" },
    ]);
  });

  it("keeps no-tab callers compatible and lets their lease gain a stable tab later", () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const { locks } = setup(() => now);
    expect(locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire" }).granted).toBe(true);
    expect(locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire" }).granted).toBe(true);

    now = new Date("2026-09-21T10:00:10Z");
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew", tabId: "a" }).granted,
    ).toBe(true);
    now = new Date("2026-09-21T10:00:20Z");
    expect(locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew" }).granted).toBe(true);

    expect(
      locks.list(ws).map(({ holderRunId, tabId, expiresAt }) => ({
        holderRunId,
        tabId,
        expiresAt,
      })),
    ).toEqual([
      { holderRunId: r1, tabId: "a", expiresAt: "2026-09-21T10:01:20.000Z" },
      { holderRunId: r2, tabId: undefined, expiresAt: "2026-09-21T10:01:00.000Z" },
    ]);
  });

  it("queues same-tab contention without stealing, then grants after release", () => {
    const { locks } = setup(() => new Date("2026-09-21T10:00:00Z"));
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" });

    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "a" }),
    ).toEqual({
      type: "browser_lock_result",
      runId: r2,
      granted: false,
      waitMessage: TAB_HELD_BY_RUN_MESSAGE,
    });
    expect(locks.list(ws)).toMatchObject([{ holderRunId: r1, tabId: "a" }]);

    locks.handle(ws, { type: "browser_lock", runId: r1, op: "release", tabId: "a" });
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "a" }).granted,
    ).toBe(true);
    expect(locks.list(ws)).toMatchObject([{ holderRunId: r2, tabId: "a" }]);
  });

  it("does not renew or move a lease onto another run's tab", () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const { locks } = setup(() => now);
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" });
    locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "b" });

    now = new Date("2026-09-21T10:00:30Z");
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "renew", tabId: "a" }),
    ).toMatchObject({ granted: false, waitMessage: TAB_HELD_BY_RUN_MESSAGE });
    expect(locks.list(ws).find((lock) => lock.holderRunId === r2)).toMatchObject({
      tabId: "b",
      expiresAt: "2026-09-21T10:01:00.000Z",
    });

    now = new Date("2026-09-21T10:00:40Z");
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "c" }).granted,
    ).toBe(true);
    // A delayed screenshot renewal must not move the lease back, even if the old tab is free.
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "renew", tabId: "b" }).granted,
    ).toBe(false);
    expect(locks.list(ws).find((lock) => lock.holderRunId === r2)?.tabId).toBe("c");
    // A delayed release for the old tab must not discard the new lease.
    locks.handle(ws, { type: "browser_lock", runId: r2, op: "release", tabId: "b" });
    expect(locks.list(ws).find((lock) => lock.holderRunId === r2)).toMatchObject({ tabId: "c" });
  });

  it("requires a fresh acquire after expiry and cleans up a completed run", () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const { locks } = setup(() => now);
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" });
    now = new Date("2026-09-21T10:00:50Z");
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew", tabId: "a" });
    now = new Date("2026-09-21T10:01:49Z");
    expect(locks.list(ws)).toHaveLength(1);
    now = new Date("2026-09-21T10:01:50Z");
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew", tabId: "a" }),
    ).toMatchObject({ granted: false, waitMessage: TAB_HELD_BY_RUN_MESSAGE });
    expect(locks.list(ws)).toHaveLength(0);

    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" }).granted,
    ).toBe(true);
    locks.releaseForRun(r1);
    expect(locks.list(ws)).toHaveLength(0);
  });

  it("does not let a stale renewal reclaim an expired tab from its successor", () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const { locks } = setup(() => now);
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" });

    now = new Date("2026-09-21T10:01:00Z");
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "a" }).granted,
    ).toBe(true);
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew", tabId: "a" }),
    ).toMatchObject({ granted: false, waitMessage: TAB_HELD_BY_RUN_MESSAGE });
    expect(locks.list(ws)).toMatchObject([{ holderRunId: r2, tabId: "a" }]);

    locks.releaseForRun(r2);
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" }).granted,
    ).toBe(true);
  });

  it("gives human takeover priority across all tabs without renewing blocked run leases", () => {
    let now = new Date("2026-09-21T10:00:00Z");
    const { locks } = setup(() => now);
    locks.handle(ws, { type: "browser_lock", runId: r1, op: "acquire", tabId: "a" });

    now = new Date("2026-09-21T10:00:10Z");
    const human = locks.humanTake(ws, 20);
    expect(human.expiresAt).toBe("2026-09-21T10:00:30.000Z");
    now = new Date("2026-09-21T10:00:20Z");
    expect(locks.handle(ws, { type: "browser_lock", runId: r1, op: "renew", tabId: "a" })).toEqual({
      type: "browser_lock_result",
      runId: r1,
      granted: false,
      waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
    });
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "b" }),
    ).toMatchObject({ granted: false, waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE });

    now = new Date("2026-09-21T10:00:31Z");
    expect(locks.humanHolds(ws)).toBe(false);
    expect(
      locks.handle(ws, { type: "browser_lock", runId: r2, op: "acquire", tabId: "b" }).granted,
    ).toBe(true);
    // The rejected renewal at 10:00:20 did not extend r1's original lease.
    now = new Date("2026-09-21T10:01:00Z");
    expect(locks.list(ws).map((lock) => lock.holderRunId)).toEqual([r2]);
  });
});
