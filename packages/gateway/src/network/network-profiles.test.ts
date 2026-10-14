// T1: the durable half of ADR-0027 amendment 1 (decisions 6, 7 and 9): profiles survive a
// Gateway restart, temporary grants expire, a failed write changes nothing, and a deleted
// workspace or profile takes its selections with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { NetworkProfileStore } from "./network-profile-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const subnet = { kind: "subnet", cidr: "192.168.10.0/24", schemes: ["http"], ports: [8080] };
const host = {
  kind: "host",
  hostname: "console.vendordb.lan",
  address: "10.20.36.35",
  schemes: ["https"],
  ports: [443],
};

function tenantOf(db: ReturnType<typeof openDatabase>): string {
  return (db.prepare("SELECT id FROM tenants LIMIT 1").get() as { id: string }).id;
}

describe("network profile store (ADR-0027 amendment 1)", () => {
  it("keeps persistent profiles and selections across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmates-netp-"));
    dirs.push(dir);
    const path = join(dir, "gateway.db");
    let db = openDatabase(path);
    const ws = new WorkspaceStore(db).create({ name: "w", sandboxProvider: "docker" });
    const store = new NetworkProfileStore(db);
    const profile = store.create({ name: "lab", rules: [subnet] }, "user:root", tenantOf(db));
    store.setSelections(ws.id, [{ profileId: profile.id }], "user:root");
    db.close();

    db = openDatabase(path);
    const reopened = new NetworkProfileStore(db);
    expect(reopened.list().map((p) => p.name)).toEqual(["lab"]);
    expect(reopened.grantsFor(ws.id)).toEqual([subnet]);
    db.close();
  });

  it("expires temporary grants at the earlier of profile and selection expiry", () => {
    const db = openDatabase(":memory:");
    const ws = new WorkspaceStore(db).create({ name: "w", sandboxProvider: "docker" });
    const store = new NetworkProfileStore(db);
    const lab = store.create(
      { name: "lab", rules: [subnet], expiresAt: "2026-10-20T00:00:00.000Z" },
      "user:root",
      tenantOf(db),
    );
    const cog = store.create({ name: "cog", rules: [host] }, "user:root", tenantOf(db));
    store.setSelections(
      ws.id,
      [{ profileId: lab.id }, { profileId: cog.id, expiresAt: "2026-10-15T00:00:00.000Z" }],
      "user:root",
    );
    const at = (iso: string) => store.grantsFor(ws.id, Date.parse(iso));
    expect(at("2026-10-14T00:00:00Z")).toEqual([
      { ...host, expiresAt: "2026-10-15T00:00:00.000Z" },
      { ...subnet, expiresAt: "2026-10-20T00:00:00.000Z" },
    ]);
    expect(at("2026-10-16T00:00:00Z")).toEqual([
      { ...subnet, expiresAt: "2026-10-20T00:00:00.000Z" },
    ]);
    expect(at("2026-10-21T00:00:00Z")).toEqual([]);
  });

  it("changes nothing when a candidate or a selection is invalid", () => {
    const db = openDatabase(":memory:");
    const ws = new WorkspaceStore(db).create({ name: "w", sandboxProvider: "docker" });
    const store = new NetworkProfileStore(db);
    const lab = store.create({ name: "lab", rules: [subnet] }, "user:root", tenantOf(db));
    store.setSelections(ws.id, [{ profileId: lab.id }], "user:root");
    expect(() =>
      store.replace(lab.id, { name: "lab", rules: [{ ...subnet, ports: [] }] }, 1, "u", "t"),
    ).toThrow();
    expect(() => store.create({ name: "lab", rules: [subnet] }, "u", tenantOf(db))).toThrow(
      /name exists/,
    );
    expect(() =>
      store.setSelections(ws.id, [{ profileId: lab.id }, { profileId: "netp_nope" }], "u"),
    ).toThrow(/not found/);
    expect(store.mustGet(lab.id).revision).toBe(1);
    expect(store.selections(ws.id).map((s) => s.profileId)).toEqual([lab.id]);
  });

  it("cascades selections when a profile or a workspace goes", () => {
    const db = openDatabase(":memory:");
    const workspaces = new WorkspaceStore(db);
    const a = workspaces.create({ name: "a", sandboxProvider: "docker" });
    const b = workspaces.create({ name: "b", sandboxProvider: "docker" });
    const store = new NetworkProfileStore(db);
    const lab = store.create({ name: "lab", rules: [subnet] }, "user:root", tenantOf(db));
    for (const ws of [a, b]) store.setSelections(ws.id, [{ profileId: lab.id }], "user:root");
    expect(store.workspacesSelecting(lab.id).sort()).toEqual([a.id, b.id].sort());
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(a.id);
    expect(store.workspacesSelecting(lab.id)).toEqual([b.id]);
    store.delete(lab.id, "user:root", tenantOf(db));
    expect(store.selections(b.id)).toEqual([]);
  });
});
