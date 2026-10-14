// T0: the Web UI's role table (`ROLE_ACTIONS` in contracts, issue #14) agrees with the route
// policy that actually decides. A screen hides or disables an action for the role named here, so
// a role that is looser than the route would offer a button the Gateway refuses, and a stricter
// one would hide something the role may do (unless a named handler check refuses the rest).

import { ROLE_ACTIONS, type RoleActionRule, mayTakeAction } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY, roleAtLeast } from "./route-policy.js";

describe("ROLE_ACTIONS", () => {
  for (const [action, rule] of Object.entries(ROLE_ACTIONS) as Array<[string, RoleActionRule]>) {
    it(`${action} names a route and the role it requires`, () => {
      const policy = ROUTE_POLICY[rule.route];
      expect(policy, `${rule.route} has no route policy`).toBeDefined();
      if (!policy) return;
      if (rule.role === "platform" || rule.role === "root") {
        expect(policy.access).toBe(rule.role);
        return;
      }
      expect(policy.access).toBe("tenant");
      if (policy.access !== "tenant") return;
      if (rule.handlerCheck === undefined) expect(rule.role).toBe(policy.role);
      else expect(rule.role !== policy.role && roleAtLeast(rule.role, policy.role)).toBe(true);
    });
  }

  it("lets a role take exactly what its rank in the workspace, root or platform maintenance allows", () => {
    const member = { tenantRole: "member", platformMaintainer: false } as const;
    const admin = { tenantRole: "admin", platformMaintainer: false } as const;
    const owner = { tenantRole: "owner", platformMaintainer: false } as const;
    const maintainer = { tenantRole: "member", platformMaintainer: true } as const;
    const root = { tenantRole: "owner", platformMaintainer: true, root: true } as const;
    expect(mayTakeAction(member, "connector.register")).toBe(false);
    expect(mayTakeAction(admin, "connector.register")).toBe(true);
    expect(mayTakeAction(admin, "people.changeRole")).toBe(true);
    expect(mayTakeAction(admin, "people.manageAdmins")).toBe(false);
    expect(mayTakeAction(owner, "people.manageAdmins")).toBe(true);
    expect(mayTakeAction(owner, "integration.adopt")).toBe(false);
    expect(mayTakeAction(maintainer, "integration.adopt")).toBe(true);
    expect(mayTakeAction(maintainer, "connector.register")).toBe(false);
    expect(mayTakeAction(owner, "servicePrincipal.manage")).toBe(false);
    expect(mayTakeAction(root, "servicePrincipal.manage")).toBe(true);
  });

  it("uses the role in the workspace a screen shows (ADR-0022 amendment 6 W11)", () => {
    const roles = {
      tenantRole: "admin",
      platformMaintainer: false,
      workspaceRoles: { wsA: "admin", wsB: "guest" },
    } as const;
    expect(mayTakeAction(roles, "bot.create", "wsA")).toBe(true);
    expect(mayTakeAction(roles, "bot.create", "wsB")).toBe(false);
    expect(mayTakeAction(roles, "thread.post", "wsB")).toBe(false);
    expect(mayTakeAction(roles, "board.post", "wsB")).toBe(true);
    expect(mayTakeAction(roles, "board.read", "wsC")).toBe(false);
    const root = { ...roles, root: true };
    expect(mayTakeAction(root, "bot.create", "wsC")).toBe(true);
  });

  it("workspace creation follows the highest role (amendment 7 S5)", () => {
    const adminOfA = {
      tenantRole: "admin",
      platformMaintainer: false,
      workspaceRoles: { wsA: "admin", wsB: "member" },
    } as const;
    expect(mayTakeAction(adminOfA, "workspace.create", "wsB")).toBe(true);
    expect(mayTakeAction(adminOfA, "bot.create", "wsB")).toBe(false);
    const memberOnly = {
      tenantRole: "member",
      platformMaintainer: false,
      workspaceRoles: { wsA: "member" },
    } as const;
    expect(mayTakeAction(memberOnly, "workspace.create", "wsA")).toBe(false);
    const rootOnly = { tenantRole: "guest", platformMaintainer: true, root: true } as const;
    expect(mayTakeAction(rootOnly, "workspace.create", "wsZ")).toBe(true);
    // Only a route that names no workspace may look past the selected one.
    for (const [action, rule] of Object.entries(ROLE_ACTIONS) as Array<[string, RoleActionRule]>)
      if (rule.scope === "any") expect(rule.route, action).not.toContain(":");
  });

  it("navigation reads only what a Guest may read (amendment 7 S6)", () => {
    const guest = { tenantRole: "guest", platformMaintainer: false } as const;
    const member = { tenantRole: "member", platformMaintainer: false } as const;
    for (const action of ["threads.list", "bots.read", "board.read", "inquiry.ask"] as const)
      expect(mayTakeAction(guest, action), action).toBe(true);
    for (const action of [
      "approvals.read",
      "costs.read",
      "desktops.read",
      "files.read",
      "integrations.read",
      "knowledge.read",
      "skills.read",
      "tasks.read",
    ] as const) {
      expect(mayTakeAction(guest, action), action).toBe(false);
      expect(mayTakeAction(member, action), action).toBe(true);
    }
  });

  it("offers a Member posts, tasks and one-time answers, a Guest the board and private inquiries, and the group's configuration to Admins (amendment 6)", () => {
    const guest = { tenantRole: "guest", platformMaintainer: false } as const;
    const member = { tenantRole: "member", platformMaintainer: false } as const;
    const admin = { tenantRole: "admin", platformMaintainer: false } as const;
    const adminOnly = [
      "thread.create",
      "thread.postBus",
      "privateChat.open",
      "thread.addMember",
      "thread.removeMember",
      "thread.setDeadline",
      "thread.closeTask",
      "task.create",
      "task.edit",
      "task.accept",
      "memory.editFile",
      "memory.consolidate",
      "memory.editEntry",
      "memory.forget",
      "memory.undo",
      "memory.confirm",
      "memory.reviewSuggestion",
      "approval.decideAny",
      "approval.decidePersistent",
      "run.cancel",
      "run.continue",
      "board.moderate",
      "bot.create",
    ] as const;
    for (const action of adminOnly) {
      expect(mayTakeAction(member, action), action).toBe(false);
      expect(mayTakeAction(admin, action), action).toBe(true);
    }
    for (const action of [
      "thread.post",
      "task.submit",
      "approval.decide",
      "costAlert.acknowledge",
      "knowledge.propose",
    ] as const) {
      expect(mayTakeAction(member, action), action).toBe(true);
      expect(mayTakeAction(guest, action), action).toBe(false);
    }
    for (const action of ["sideChat.open", "thread.read", "board.read", "board.post"] as const)
      expect(mayTakeAction(guest, action), action).toBe(true);
  });
});
