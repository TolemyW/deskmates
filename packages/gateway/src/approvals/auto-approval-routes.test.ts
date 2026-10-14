// T1, ADR-0002 amendment 4 B1: the workspace automatic-approval setting is off by default, an
// Owner or Admin changes it, a Member or Guest cannot, and each change is one audit row.

import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Setting = { autoApproval: { workspaceId: string; enabled: boolean } };

describe("workspace automatic approval setting (B1)", () => {
  it("is off for a new workspace and audited on every change", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const read = await h.api<Setting>("GET", `/api/workspaces/${workspace.id}/auto-approval`);
    expect(read.status).toBe(200);
    expect(read.json.autoApproval).toEqual({ workspaceId: workspace.id, enabled: false });

    const on = await h.api<Setting>("PUT", `/api/workspaces/${workspace.id}/auto-approval`, {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(on.json.autoApproval.enabled).toBe(true);
    // Setting the same value again changes and records nothing.
    await h.api("PUT", `/api/workspaces/${workspace.id}/auto-approval`, { enabled: true });
    await h.api("PUT", `/api/workspaces/${workspace.id}/auto-approval`, { enabled: false });

    const audit = h.app.deskmates.ctx.audit
      .list({ workspaceId: workspace.id })
      .filter((row) => row.action === "workspace.auto_approval_set");
    expect(audit.map((row) => [row.before, row.after])).toEqual([
      [{ autoApproval: true }, { autoApproval: false }],
      [{ autoApproval: false }, { autoApproval: true }],
    ]);
    expect(audit[0]?.targetId).toBe(workspace.id);

    const invalid = await h.api("PUT", `/api/workspaces/${workspace.id}/auto-approval`, {
      enabled: "yes",
    });
    expect(invalid.status).toBe(400);
  });

  it("an Admin may change it; a Member and a Guest may only read it", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const ws = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    for (const [loginName, role] of [
      ["ada", "admin"],
      ["mel", "member"],
      ["gus", "guest"],
    ] as const)
      await ctx.auth.createUser({
        loginName,
        displayName: loginName,
        password: TEST_PASSWORD,
        role,
        workspaceId: ws.id,
      });
    const path = `/api/workspaces/${ws.id}/auto-approval`;

    const member = new BrowserJar(h.baseUrl);
    expect((await member.signIn("mel")).status).toBe(200);
    expect((await member.fetch("GET", path)).status).toBe(200);
    expect((await member.fetch("PUT", path, { body: { enabled: true } })).status).toBe(403);

    const guest = new BrowserJar(h.baseUrl);
    expect((await guest.signIn("gus")).status).toBe(200);
    expect((await guest.fetch("PUT", path, { body: { enabled: true } })).status).toBe(403);

    const admin = new BrowserJar(h.baseUrl);
    expect((await admin.signIn("ada")).status).toBe(200);
    const changed = await admin.json<Setting>("PUT", path, { body: { enabled: true } });
    expect(changed.status).toBe(200);
    expect(changed.json.autoApproval.enabled).toBe(true);
    const row = ctx.audit
      .list({ workspaceId: ws.id })
      .find((entry) => entry.action === "workspace.auto_approval_set");
    expect(row?.actor).toBe(`user:${ctx.auth.users.findLocalLogin("ada")?.userId}`);
  });
});
