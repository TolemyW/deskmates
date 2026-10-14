// T1: workspace memberships and the protected root account (ADR-0031 decisions 7 and 8).
// Identity and membership are separate; one person holds different roles in different
// workspaces; the root is Owner of every workspace and the schema refuses every way to demote,
// remove, disable or re-designate it; a login named `admin` gains nothing by its name.

import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { WorkspaceMembershipStore } from "../workspaces/memberships.js";
import { WorkspaceStore } from "../workspaces/workspaces.js";
import { AuthService, PROTECTED_ROOT_LOGIN } from "./auth-service.js";
import { DEFAULT_TENANT_ID } from "./user-store.js";

let db: GatewayDb;
let auth: AuthService;
let workspaces: WorkspaceStore;
let memberships: WorkspaceMembershipStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  auth = new AuthService(db, { passwordMinLength: 8 });
  workspaces = new WorkspaceStore(db);
  memberships = new WorkspaceMembershipStore(db);
});

const PASSWORD = "correct horse battery staple";

describe("workspace memberships (ADR-0031 decision 7)", () => {
  it("one person holds different roles in two workspaces; the creator is Owner", async () => {
    const creator = await auth.createUser({
      loginName: "carol",
      displayName: "Carol",
      password: PASSWORD,
      role: "member",
    });
    const a = workspaces.create({ name: "A", sandboxProvider: "docker", ownerUserId: creator.id });
    const b = workspaces.create({ name: "B", sandboxProvider: "docker" });
    const pat = await auth.createUser({
      loginName: "pat",
      displayName: "Pat",
      password: PASSWORD,
      role: "admin",
      workspaceId: a.id,
    });
    memberships.add(b.id, pat.id, "guest", "user:test");
    expect(memberships.roleIn(a.id, creator.id)).toBe("owner");
    expect(memberships.roleIn(a.id, pat.id)).toBe("admin");
    expect(memberships.roleIn(b.id, pat.id)).toBe("guest");
    expect(memberships.roleIn(b.id, creator.id)).toBeUndefined();
    expect(auth.roleInWorkspace({ userId: pat.id }, b.id)).toBe("guest");
    expect(memberships.highestRole(DEFAULT_TENANT_ID, pat.id)).toBe("admin");
  });

  it("a workspace keeps its last Owner and every change bumps the version and is audited", async () => {
    const ws = workspaces.create({ name: "W", sandboxProvider: "docker" });
    const alice = await auth.createUser({
      loginName: "alice",
      displayName: "Alice",
      password: PASSWORD,
      role: "owner",
      workspaceId: ws.id,
    });
    const before = memberships.get(ws.id, alice.id)?.authVersion ?? 0;
    expect(() => memberships.change(ws.id, alice.id, { role: "admin" }, "user:x")).toThrow(
      /last Owner/,
    );
    expect(() => memberships.change(ws.id, alice.id, { status: "removed" }, "user:x")).toThrow(
      /last Owner/,
    );
    const bob = await auth.createUser({
      loginName: "bob",
      displayName: "Bob",
      password: PASSWORD,
      role: "owner",
      workspaceId: ws.id,
    });
    expect(memberships.change(ws.id, alice.id, { role: "admin" }, "user:x").authVersion).toBe(
      before + 1,
    );
    expect(() => memberships.change(ws.id, bob.id, { role: "member" }, "user:x")).toThrow(
      /last Owner/,
    );
    const audited = db
      .prepare("SELECT action FROM audit_events WHERE target_id = ? ORDER BY seq")
      .all(alice.id);
    expect(audited).toEqual([{ action: "membership.add" }, { action: "membership.role" }]);
  });

  it("an invitation never makes an Owner", () => {
    const ws = workspaces.create({ name: "W", sandboxProvider: "docker" });
    expect(() =>
      auth.invitations.create(DEFAULT_TENANT_ID, {
        workspaceId: ws.id,
        role: "owner" as never,
        target: { kind: "local_signup" },
        createdBy: "user:x",
      }),
    ).toThrow(/admin, member or guest/);
  });
});

describe("the protected root account (ADR-0031 decision 8)", () => {
  it("is created once on an empty database, as admin/admin with a forced change", async () => {
    const root = await auth.ensureProtectedRoot();
    expect(root).toBeDefined();
    expect(await auth.ensureProtectedRoot()).toBeUndefined();
    const login = auth.users.findLocalLogin(PROTECTED_ROOT_LOGIN);
    expect(login?.userId).toBe(root?.id);
    expect(auth.users.mustChangePassword(login?.id ?? "")).toBe(true);
    expect(root?.platformRole).toBe("maintainer");
    const { session } = await auth.login("admin", "admin", "127.0.0.1");
    expect(auth.mustChangePassword(session)).toBe(true);
  });

  it("is Owner of every workspace, existing and new, and stays so", async () => {
    const before = workspaces.create({ name: "Before", sandboxProvider: "docker" });
    const root = (await auth.ensureProtectedRoot()) ?? (undefined as never);
    const after = workspaces.create({ name: "After", sandboxProvider: "docker" });
    expect(memberships.roleIn(before.id, root.id)).toBe("owner");
    expect(memberships.roleIn(after.id, root.id)).toBe("owner");
    // With a second Owner the last-Owner rule passes and the schema still refuses.
    const second = await auth.createUser({
      loginName: "second",
      displayName: "Second",
      password: PASSWORD,
      role: "owner",
      workspaceId: after.id,
    });
    expect(memberships.roleIn(after.id, second.id)).toBe("owner");
    expect(() => memberships.change(after.id, root.id, { role: "admin" }, "user:x")).toThrow(
      /stays Owner/,
    );
    expect(() =>
      db
        .prepare("DELETE FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?")
        .run(root.id, after.id),
    ).toThrow(/stays Owner/);
    expect(() =>
      auth.users.updateMembership(DEFAULT_TENANT_ID, root.id, { status: "removed" }),
    ).toThrow(/protected/);
    expect(() => auth.users.setUserStatus(root.id, "disabled")).toThrow(/cannot be disabled/);
    expect(() => db.prepare("UPDATE users SET is_protected = 0 WHERE id = ?").run(root.id)).toThrow(
      /stays protected/,
    );
    expect(memberships.highestRole(DEFAULT_TENANT_ID, root.id)).toBe("owner");
  });

  it("is never designated by name: a later account called admin gains nothing", async () => {
    const other = await auth.createUser({
      loginName: "someone",
      displayName: "Someone",
      password: PASSWORD,
      role: "member",
    });
    expect(() =>
      db.prepare("UPDATE users SET is_protected = 1 WHERE id = ?").run(other.id),
    ).toThrow(/designated when it is created/);
    // A database that already has an account gets no root, so `admin` cannot be claimed.
    expect(await auth.ensureProtectedRoot()).toBeUndefined();
    const impostor = await auth.createUser({
      loginName: "Admin",
      displayName: "admin",
      password: PASSWORD,
      role: "member",
    });
    const ws = workspaces.create({ name: "W", sandboxProvider: "docker" });
    expect(memberships.roleIn(ws.id, impostor.id)).toBeUndefined();
    expect(auth.users.isProtected(impostor.id)).toBe(false);
  });

  it("only one account is ever protected", async () => {
    await auth.ensureProtectedRoot();
    await expect(
      auth.createUser({
        loginName: "second",
        displayName: "Second",
        password: PASSWORD,
        role: "owner",
        protectedRoot: true,
      }),
    ).rejects.toThrow(/UNIQUE/);
  });
});
