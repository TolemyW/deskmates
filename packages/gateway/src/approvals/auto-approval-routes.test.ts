// T1, ADR-0002 amendment 6 D1 and D7 (replacing amendment 4 B1): the workspace approval mode is
// `automatic` for a new workspace, an Owner or Admin changes it among the three modes, a Member or
// Guest cannot, and each change is one audit row; the expiry defaults to 60 minutes.

import { afterEach, describe, expect, it } from "vitest";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Setting = {
  autoApproval: { workspaceId: string; mode: string; enabled: boolean; expiryMinutes: number };
};

/** A workspace through the product route, so the defaults are the product's (not the fixture's). */
async function newWorkspace(harness: Harness): Promise<string> {
  const created = await harness.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
    name: "modes",
    egressAllowlist: ["*.example.test"],
  });
  expect(created.status).toBe(201);
  return created.json.workspace.id;
}

describe("workspace approval mode (amendment 6, D1)", () => {
  it("is automatic with a 60-minute expiry for a new workspace and audited on every change", async () => {
    h = await startHarness();
    const workspaceId = await newWorkspace(h);
    const path = `/api/workspaces/${workspaceId}/auto-approval`;
    const read = await h.api<Setting>("GET", path);
    expect(read.status).toBe(200);
    expect(read.json.autoApproval).toEqual({
      workspaceId,
      mode: "automatic",
      enabled: true,
      expiryMinutes: 60,
    });

    const all = await h.api<Setting>("PUT", path, { mode: "approve_all" });
    expect(all.status).toBe(200);
    expect(all.json.autoApproval).toMatchObject({ mode: "approve_all", enabled: false });
    // Setting the same value again changes and records nothing.
    await h.api("PUT", path, { mode: "approve_all" });
    const manual = await h.api<Setting>("PUT", path, { mode: "manual" });
    expect(manual.json.autoApproval.mode).toBe("manual");
    // The legacy boolean of amendment 4 still means automatic or manual.
    const legacy = await h.api<Setting>("PUT", path, { enabled: true });
    expect(legacy.json.autoApproval.mode).toBe("automatic");

    const audit = h.app.deskmates.ctx.audit
      .list({ workspaceId })
      .filter((row) => row.action === "workspace.approval_mode_set");
    expect(audit.map((row) => [row.before, row.after])).toEqual([
      [{ approvalMode: "manual" }, { approvalMode: "automatic" }],
      [{ approvalMode: "approve_all" }, { approvalMode: "manual" }],
      [{ approvalMode: "automatic" }, { approvalMode: "approve_all" }],
    ]);
    expect(audit[0]?.targetId).toBe(workspaceId);

    for (const body of [{ enabled: "yes" }, { mode: "everything" }, { mode: 1 }, {}])
      expect((await h.api("PUT", path, body)).status).toBe(400);
  });

  it("changes the request expiry within 1 to 1440 minutes, audited (amendment 3, A7)", async () => {
    h = await startHarness();
    const workspaceId = await newWorkspace(h);
    const path = `/api/workspaces/${workspaceId}/auto-approval`;
    const set = await h.api<Setting>("PUT", path, { expiryMinutes: 30 });
    expect(set.status).toBe(200);
    expect(set.json.autoApproval).toMatchObject({ mode: "automatic", expiryMinutes: 30 });
    await h.api("PUT", path, { expiryMinutes: 30 });
    for (const bad of [0, 1441, 2.5, "10"])
      expect((await h.api("PUT", path, { expiryMinutes: bad })).status).toBe(400);
    const audit = h.app.deskmates.ctx.audit
      .list({ workspaceId })
      .filter((row) => row.action === "workspace.approval_expiry_set");
    expect(audit.map((row) => [row.before, row.after])).toEqual([
      [{ approvalExpiryMinutes: 60 }, { approvalExpiryMinutes: 30 }],
    ]);
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
    expect((await member.fetch("PUT", path, { body: { mode: "approve_all" } })).status).toBe(403);
    expect((await member.fetch("PUT", path, { body: { expiryMinutes: 5 } })).status).toBe(403);

    const guest = new BrowserJar(h.baseUrl);
    expect((await guest.signIn("gus")).status).toBe(200);
    expect((await guest.fetch("PUT", path, { body: { mode: "manual" } })).status).toBe(403);

    const admin = new BrowserJar(h.baseUrl);
    expect((await admin.signIn("ada")).status).toBe(200);
    const changed = await admin.json<Setting>("PUT", path, { body: { mode: "approve_all" } });
    expect(changed.status).toBe(200);
    expect(changed.json.autoApproval.mode).toBe("approve_all");
    const row = ctx.audit
      .list({ workspaceId: ws.id })
      .find((entry) => entry.action === "workspace.approval_mode_set");
    expect(row?.actor).toBe(`user:${ctx.auth.users.findLocalLogin("ada")?.userId}`);
  });
});
