// T0, ADR-0022 amendment 7 S9: the role panel's matrix is read from `ROLE_ACTIONS` and answers
// what `mayTakeAction` answers, so the panel cannot drift from the table the Gateway checks.

import { describe, expect, it } from "vitest";
import { WORKSPACE_ROLES } from "./auth.js";
import { ROLE_ACTIONS, type RoleAction, mayTakeAction, roleActionMatrix } from "./role-actions.js";

describe("roleActionMatrix", () => {
  it("the role matrix is the table: every action once, each cell as mayTakeAction answers", () => {
    const { workspace, administrator } = roleActionMatrix();
    const listed = [...workspace.map((row) => row.action), ...administrator];
    expect([...listed].sort()).toEqual(Object.keys(ROLE_ACTIONS).sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const row of workspace)
      for (const role of WORKSPACE_ROLES)
        expect(row.allowed[role], `${row.action} for ${role}`).toBe(
          mayTakeAction(
            { tenantRole: role, platformMaintainer: false, workspaceRoles: { ws: role } },
            row.action,
            "ws",
          ),
        );
  });

  it("keeps the table's order and ranks: an Owner takes every workspace action, a Guest few", () => {
    const { workspace, administrator } = roleActionMatrix();
    const order = Object.keys(ROLE_ACTIONS) as RoleAction[];
    expect(workspace.map((r) => r.action)).toEqual(order.filter((a) => !administrator.includes(a)));
    expect(workspace.every((row) => row.allowed.owner)).toBe(true);
    const board = workspace.find((row) => row.action === "board.post");
    expect(board?.allowed).toEqual({ owner: true, admin: true, member: true, guest: true });
    const manageAdmins = workspace.find((row) => row.action === "people.manageAdmins");
    expect(manageAdmins?.allowed).toEqual({
      owner: true,
      admin: false,
      member: false,
      guest: false,
    });
    expect(manageAdmins?.limitedBelow).toBe(true);
    expect(administrator).toContain("integration.adopt");
    // Network profiles moved from root to workspace Owners (ADR-0027 amendment 1, 2026-10-14).
    expect(workspace.map((row) => row.action)).toContain("network.read");
  });
});
