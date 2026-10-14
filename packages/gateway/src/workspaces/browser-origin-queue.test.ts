import type { BrowserOriginRequest, RunId, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { BROWSER_ORIGIN_RETRY_AFTER_MS, BrowserOriginQueueStore } from "./browser-origin-queue.js";

const workspaceA = "workspace-a" as WorkspaceId;
const workspaceB = "workspace-b" as WorkspaceId;
const run1 = "run-1" as RunId;
const run2 = "run-2" as RunId;
const run3 = "run-3" as RunId;
const originA = "https://alpha.example.test";
const originB = "https://beta.example.test";

function request(
  runId: RunId,
  op: BrowserOriginRequest["op"],
  origin?: string,
): BrowserOriginRequest {
  return { type: "browser_origin", runId, op, ...(origin === undefined ? {} : { origin }) };
}

function setup() {
  let now = new Date("2026-09-23T02:00:00.000Z");
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES
      ('workspace-a', 'tnt_default', 'A', 'docker', 'ready', '2026-09-23T00:00:00.000Z'),
      ('workspace-b', 'tnt_default', 'B', 'docker', 'ready', '2026-09-23T00:00:00.000Z');
    INSERT INTO bots (id, name, role, workspace_id, created_at) VALUES
      ('bot-a', 'a', 'test', 'workspace-a', '2026-09-23T00:00:00.000Z'),
      ('bot-b', 'b', 'test', 'workspace-b', '2026-09-23T00:00:00.000Z');
    INSERT INTO runs (id, workspace_id, bot_id, lane, trigger_kind, trigger_ref, status, created_at) VALUES
      ('run-1', 'workspace-a', 'bot-a', 'interactive', 'thread_message', 'm1', 'running', '2026-09-23T00:00:00.000Z'),
      ('run-2', 'workspace-a', 'bot-a', 'background', 'thread_message', 'm2', 'running', '2026-09-23T00:00:00.000Z'),
      ('run-3', 'workspace-b', 'bot-b', 'interactive', 'thread_message', 'm3', 'running', '2026-09-23T00:00:00.000Z');
  `);
  return {
    db,
    queue: new BrowserOriginQueueStore(db, 10, () => now),
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe("browser origin queue (ADR-0007 candidate)", () => {
  it("grants same-origin requests in durable FIFO order", () => {
    const f = setup();
    expect(f.queue.handle(workspaceA, request(run1, "acquire", originA), false)).toMatchObject({
      granted: true,
      origin: originA,
    });
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originA), false)).toEqual({
      type: "browser_origin_result",
      runId: run2,
      granted: false,
      origin: originA,
      waitReason: "origin_busy",
      retryAfterMs: BROWSER_ORIGIN_RETRY_AFTER_MS,
    });
    const beforeRetry = f.queue.list(workspaceA);
    f.setNow("2026-09-23T02:00:01.000Z");
    f.queue.handle(workspaceA, request(run2, "acquire", originA), false);
    expect(f.queue.list(workspaceA)[1]).toMatchObject({
      id: beforeRetry[1]?.id,
      queuedAt: beforeRetry[1]?.queuedAt,
      status: "pending",
    });

    f.queue.handle(workspaceA, request(run1, "release", originA), false);
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA)).toMatchObject([
      {
        runId: run2,
        status: "held",
        queuedAt: "2026-09-23T02:00:00.000Z",
        grantedAt: "2026-09-23T02:00:01.000Z",
      },
    ]);
    f.setNow("2026-09-23T02:00:02.000Z");
    expect(f.queue.handle(workspaceA, request(run2, "renew", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA)).toMatchObject([
      {
        grantedAt: "2026-09-23T02:00:01.000Z",
        expiresAt: "2026-09-23T02:00:12.000Z",
      },
    ]);
  });

  it("grants different origins and workspaces independently", () => {
    const f = setup();
    expect(f.queue.handle(workspaceA, request(run1, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originB), false).granted).toBe(true);
    expect(f.queue.handle(workspaceB, request(run3, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA).map(({ status }) => status)).toEqual(["held", "held"]);
    expect(f.queue.list(workspaceB)).toMatchObject([{ runId: run3, status: "held" }]);
  });

  it("releases the old origin before a run queues for a new one", () => {
    const f = setup();
    f.queue.handle(workspaceA, request(run1, "acquire", originA), false);
    f.queue.handle(workspaceA, request(run2, "acquire", originA), false);

    expect(f.queue.handle(workspaceA, request(run1, "acquire", originB), false).granted).toBe(true);
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA)).toMatchObject([
      { runId: run2, origin: originA, status: "held" },
      { runId: run1, origin: originB, status: "held" },
    ]);
    expect(f.queue.list(workspaceA).filter(({ runId }) => runId === run1)).toHaveLength(1);
  });

  it("expires orphan holders while a polling waiter keeps its FIFO entry", () => {
    const f = setup();
    f.queue.handle(workspaceA, request(run1, "acquire", originA), false);
    f.queue.handle(workspaceA, request(run2, "acquire", originA), false);
    const waiterId = f.queue.list(workspaceA)[1]?.id;

    f.setNow("2026-09-23T02:00:05.000Z");
    f.queue.handle(workspaceA, request(run2, "acquire", originA), false);
    f.setNow("2026-09-23T02:00:10.000Z");
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA)).toMatchObject([{ id: waiterId, runId: run2, status: "held" }]);

    f.setNow("2026-09-23T02:00:20.000Z");
    expect(f.queue.handle(workspaceA, request(run2, "renew", originA), false)).toMatchObject({
      granted: false,
      waitReason: "lease_lost",
    });
    expect(f.queue.list(workspaceA)).toHaveLength(0);
  });

  it("makes release idempotent, stale-safe, and usable to cancel a waiter", () => {
    const f = setup();
    f.queue.handle(workspaceA, request(run1, "acquire", originA), false);
    f.queue.handle(workspaceA, request(run1, "acquire", originB), false);
    f.queue.handle(workspaceA, request(run1, "release", originA), false);
    expect(f.queue.list(workspaceA)).toMatchObject([{ runId: run1, origin: originB }]);

    f.queue.handle(workspaceA, request(run2, "acquire", originB), false);
    f.queue.handle(workspaceA, request(run2, "release"), false);
    f.queue.handle(workspaceA, request(run2, "release"), false);
    expect(f.queue.list(workspaceA)).toMatchObject([{ runId: run1, origin: originB }]);

    f.queue.releaseForRun(run1);
    expect(f.queue.list(workspaceA)).toHaveLength(0);
  });

  it("preempts holders for human takeover without changing FIFO order", () => {
    const f = setup();
    f.queue.handle(workspaceA, request(run1, "acquire", originA), false);
    f.queue.handle(workspaceA, request(run2, "acquire", originA), false);
    const ids = f.queue.list(workspaceA).map(({ id }) => id);

    f.setNow("2026-09-23T02:00:01.000Z");
    f.queue.preempt(workspaceA);
    const preempted = f.queue.list(workspaceA);
    expect(preempted).toMatchObject([
      { id: ids[0], runId: run1, status: "pending" },
      { id: ids[1], runId: run2, status: "pending" },
    ]);
    expect(preempted[0]).not.toHaveProperty("grantedAt");
    expect(f.queue.handle(workspaceA, request(run2, "acquire", originA), true)).toMatchObject({
      granted: false,
      waitReason: "human",
    });
    expect(f.queue.handle(workspaceA, request(run2, "renew", originA), true)).toMatchObject({
      granted: false,
      waitReason: "lease_lost",
    });

    expect(f.queue.handle(workspaceA, request(run1, "acquire", originA), false).granted).toBe(true);
    expect(f.queue.list(workspaceA).map(({ id }) => id)).toEqual(ids);
  });

  it("rejects missing or non-canonical non-HTTP origins without creating state", () => {
    const f = setup();
    for (const origin of [
      undefined,
      "file:///tmp/x",
      "https://user@alpha.example.test",
      `${originA}/x`,
    ]) {
      expect(() => f.queue.handle(workspaceA, request(run1, "acquire", origin), false)).toThrow(
        /origin/,
      );
    }
    expect(() =>
      f.queue.handle(workspaceA, request(run1, "release", `${originA}/path`), false),
    ).toThrow(/origin/);
    expect(f.queue.list(workspaceA)).toHaveLength(0);
  });
});
