import type { RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { RunTokenStore, hashToken } from "./run-tokens.js";

function seedRun(db: ReturnType<typeof openDatabase>, id: string): RunId {
  db.exec(
    "INSERT OR IGNORE INTO workspaces (id,tenant_id,name,sandbox_provider,status,created_at) VALUES ('w','tnt_default','w','docker','ready','t');" +
      "INSERT OR IGNORE INTO bots (id,name,role,workspace_id,created_at) VALUES ('b','b','r','w','t')",
  );
  db.prepare(
    "INSERT INTO runs (workspace_id, id,bot_id,lane,trigger_kind,trigger_ref,status,created_at) VALUES ('w', ?,'b','interactive','thread_message','m','queued','t')",
  ).run(id);
  return id as RunId;
}

describe("short-lived run tokens (ADR-0002 definitions; test strategy §4.2, §6)", () => {
  it("issues an opaque token, stores only its hash, and verifies it back to the run", () => {
    const db = openDatabase(":memory:");
    const runId = seedRun(db, "run1");
    const store = new RunTokenStore(db, 60);
    const issued = store.issue(runId);
    expect(issued.token.length).toBeGreaterThan(30);
    const row = db.prepare("SELECT token_hash FROM run_tokens").get() as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(issued.token));
    expect(row.token_hash).not.toContain(issued.token);
    expect(store.verify(issued.token)).toEqual({ runId, expiresAt: issued.expiresAt });
    expect(store.verify("cbt_nope")).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const db = openDatabase(":memory:");
    const runId = seedRun(db, "run1");
    let now = new Date("2026-09-21T10:00:00.000Z");
    const store = new RunTokenStore(db, 100, () => now);
    const issued = store.issue(runId);
    now = new Date("2026-09-21T10:01:39.000Z");
    expect(store.verify(issued.token)).toBeDefined();
    now = new Date("2026-09-21T10:01:40.000Z");
    expect(store.verify(issued.token)).toBeUndefined();
  });

  it("rejects a revoked token and revokes only the given run's tokens", () => {
    const db = openDatabase(":memory:");
    const a = seedRun(db, "runA");
    const b = seedRun(db, "runB");
    const store = new RunTokenStore(db, 60);
    const ta = store.issue(a);
    const tb = store.issue(b);
    expect(store.revokeForRun(a)).toBe(1);
    expect(store.verify(ta.token)).toBeUndefined();
    expect(store.verify(tb.token)?.runId).toBe(b);
    expect(store.revokeForRun(a)).toBe(0);
  });

  it("prunes expired and long-revoked rows and keeps the live one", () => {
    const db = openDatabase(":memory:");
    const a = seedRun(db, "runA");
    const b = seedRun(db, "runB");
    const c = seedRun(db, "runC");
    let now = new Date("2026-09-21T10:00:00.000Z");
    // One row per sidecar process and nothing ever deleted one: the table grew forever.
    const shortLived = new RunTokenStore(db, 60, () => now);
    const longLived = new RunTokenStore(db, 30 * 24 * 3600, () => now);
    const expires = shortLived.issue(a);
    const revoked = longLived.issue(b);
    const live = longLived.issue(c);
    longLived.revokeForRun(b);

    // 25 h later: `a`'s token is long past its expiry and `b`'s was revoked over a day ago.
    now = new Date("2026-09-22T11:00:00.000Z");
    expect(longLived.pruneExpired()).toBe(2);
    const left = db.prepare("SELECT token_hash FROM run_tokens").all() as {
      token_hash: string;
    }[];
    expect(left.map((r) => r.token_hash)).toEqual([hashToken(live.token)]);
    expect(longLived.verify(live.token)?.runId).toBe(c);
    expect(longLived.verify(expires.token)).toBeUndefined();
    expect(longLived.verify(revoked.token)).toBeUndefined();
    // Nothing left to prune on the next pass.
    expect(longLived.pruneExpired()).toBe(0);
  });

  it("keeps a token revoked only moments ago, so a just-ended run is still auditable", () => {
    const db = openDatabase(":memory:");
    const a = seedRun(db, "runA");
    let now = new Date("2026-09-21T10:00:00.000Z");
    const store = new RunTokenStore(db, 30 * 24 * 3600, () => now);
    const issued = store.issue(a);
    store.revokeForRun(a);
    now = new Date("2026-09-21T11:00:00.000Z");
    expect(store.pruneExpired()).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM run_tokens").get() as { n: number }).n).toBe(1);
    // Still revoked, just not deleted yet.
    expect(store.verify(issued.token)).toBeUndefined();
  });
});
