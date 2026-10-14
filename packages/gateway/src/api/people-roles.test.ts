// T1: people are managed per workspace (ADR-0022 amendment 6 W3, W4, W9). An Admin manages
// Members and Guests and may promote to Admin; demoting or removing an Admin and anything about
// Owner stay the Owner's; the root is never changed; every People call names its workspace.

import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("people per workspace (ADR-0022 amendment 6)", () => {
  it("an Admin manages Members and Guests and promotes to Admin, nothing above", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    const ws = people.workspace.id;
    const roleOf = (login: string) =>
      h?.app.deskmates.ctx.auth.memberships.roleIn(ws, people.ids[login] as string);
    const patch = (login: string, body: Record<string, unknown>) =>
      people.admin.fetch("PATCH", `/api/members/${people.ids[login]}`, {
        body: { workspaceId: ws, ...body },
      });
    expect((await patch("mel", { role: "guest" })).status).toBe(200);
    expect(roleOf("mel")).toBe("guest");
    expect((await patch("mel", { role: "member" })).status).toBe(200);
    expect((await patch("gus", { role: "admin" })).status).toBe(200);
    expect(roleOf("gus")).toBe("admin");
    // Now an Admin: only the Owner demotes or removes them.
    expect((await patch("gus", { role: "member" })).status).toBe(403);
    expect((await patch("gus", { status: "removed" })).status).toBe(403);
    expect((await patch("max", { role: "owner" })).status).toBe(403);
    expect((await patch("oona", { role: "member" })).status).toBe(403);
    expect(roleOf("gus")).toBe("admin");
    expect(roleOf("max")).toBe("member");
    // Invitations and created accounts carry Admin, Member or Guest, never Owner.
    for (const role of ["guest", "member", "admin"]) {
      const invited = await people.admin.fetch("POST", "/api/invitations", {
        body: { workspaceId: ws, role, target: { kind: "local_signup" } },
      });
      expect(invited.status, role).toBe(201);
    }
    expect(
      (
        await people.admin.fetch("POST", "/api/invitations", {
          body: { workspaceId: ws, role: "owner", target: { kind: "local_signup" } },
        })
      ).status,
    ).toBe(400);
    const made = await people.admin.json<{ member: { role: string } }>("POST", "/api/accounts", {
      body: { workspaceId: ws, loginName: "newguest", role: "guest" },
    });
    expect(made.status).toBe(201);
    expect(made.json.member.role).toBe("guest");
    // A Member manages nobody.
    expect((await people.otherMember.fetch("GET", `/api/members?workspaceId=${ws}`)).status).toBe(
      403,
    );
  });

  it("an Owner demotes an Admin; the root stays Owner", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    const ws = people.workspace.id;
    const demoted = await people.owner.fetch("PATCH", `/api/members/${people.ids.ada}`, {
      body: { workspaceId: ws, role: "member" },
    });
    expect(demoted.status).toBe(200);
    const removed = await people.owner.fetch("PATCH", `/api/members/${people.ids.max}`, {
      body: { workspaceId: ws, status: "removed" },
    });
    expect(removed.status).toBe(200);
    expect(
      h.app.deskmates.ctx.auth.memberships.roleIn(ws, people.ids.max as string),
    ).toBeUndefined();
    const root = await people.owner.fetch("PATCH", `/api/members/${people.ids.admin}`, {
      body: { workspaceId: ws, role: "member" },
    });
    expect(root.status).toBe(403);
    expect(h.app.deskmates.ctx.auth.memberships.roleIn(ws, people.ids.admin as string)).toBe(
      "owner",
    );
  });

  it("people calls name their workspace", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    const ws = people.workspace.id;
    const other = h.app.deskmates.ctx.workspaces.create({
      name: "Other",
      sandboxProvider: "docker",
    });
    // Two workspaces: a call without one is refused, not guessed.
    const unnamed = await people.root.json<{ details?: { reason?: string } }>(
      "GET",
      "/api/members",
    );
    expect(unnamed.status).toBe(400);
    expect(unnamed.json.details?.reason).toBe("workspace_required");
    const listed = await people.root.json<{
      members: Array<{ userId: string; role: string; workspaceId: string; protected: boolean }>;
    }>("GET", `/api/members?workspaceId=${ws}`);
    expect(listed.status).toBe(200);
    expect(listed.json.members.find((m) => m.userId === people.ids.gus)?.role).toBe("guest");
    expect(listed.json.members.find((m) => m.userId === people.ids.admin)?.protected).toBe(true);
    const otherList = await people.root.json<{ members: Array<{ userId: string }> }>(
      "GET",
      `/api/members?workspaceId=${other.id}`,
    );
    expect(otherList.json.members.map((m) => m.userId)).toEqual([people.ids.admin]);
    // An Admin of W is nobody in the other workspace.
    expect((await people.admin.fetch("GET", `/api/members?workspaceId=${other.id}`)).status).toBe(
      404,
    );
  });
});
