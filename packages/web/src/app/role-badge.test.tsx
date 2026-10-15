// @vitest-environment jsdom
// T0, ADR-0022 amendment 7 S8 and S9: every signed-in person sees their role in the selected
// workspace at the top right, a Guest's reads "Guest · read-only", and the badge opens a panel
// generated from `ROLE_ACTIONS` with the person's own column marked.
import "@testing-library/jest-dom/vitest";
import {
  ROLE_ACTIONS,
  type RoleAction,
  type SessionRoles,
  UI_LOCALES,
  WORKSPACE_ROLES,
  mayTakeAction,
} from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS } from "../i18n/catalogs.js";
import { I18nProvider } from "../i18n/i18n-provider.js";
import { RoleBadge } from "./role-badge.js";
import { actionLabelKey } from "./role-panel.js";

afterEach(cleanup);

const A = "ws_a";
const B = "ws_b";
const ROLES: SessionRoles = {
  tenantRole: "admin",
  platformMaintainer: false,
  workspaceRoles: { [A]: "admin", [B]: "guest" },
};
const ROOT: SessionRoles = { tenantRole: "owner", platformMaintainer: true, root: true };
const single = (role: (typeof WORKSPACE_ROLES)[number]): SessionRoles => ({
  tenantRole: role,
  platformMaintainer: false,
  workspaceRoles: { [A]: role },
});

const badge = () => screen.getByTestId("role-badge");

describe("role badge (S8)", () => {
  it("names the role in the selected workspace for Owner, Admin, Member and Guest", () => {
    const names = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest · read-only" };
    for (const role of WORKSPACE_ROLES) {
      const { unmount } = render(<RoleBadge roles={single(role)} workspaceId={A} />);
      expect(badge()).toHaveTextContent(names[role]);
      expect(badge()).toHaveAttribute("data-role", role);
      expect(badge()).toHaveAccessibleName(new RegExp(names[role]));
      unmount();
    }
  });

  it("follows the selected workspace: Admin in one, Guest · read-only in the other", () => {
    const { rerender } = render(<RoleBadge roles={ROLES} workspaceId={A} />);
    expect(badge()).toHaveTextContent("Admin");
    rerender(<RoleBadge roles={ROLES} workspaceId={B} />);
    expect(badge()).toHaveTextContent("Guest · read-only");
  });

  it("names the administrator account as such", () => {
    render(<RoleBadge roles={ROOT} workspaceId={A} />);
    expect(badge()).toHaveTextContent("Administrator account");
    expect(badge()).toHaveAttribute("data-role", "root");
  });

  it("speaks the UI's language", () => {
    render(
      <I18nProvider locale="zh-CN">
        <RoleBadge roles={ROLES} workspaceId={B} />
      </I18nProvider>,
    );
    expect(badge()).toHaveTextContent("访客 · 只读");
  });
});

describe("role panel (S9)", () => {
  it("lists every action once, each cell as mayTakeAction answers, the Guest's column marked", () => {
    render(<RoleBadge roles={ROLES} workspaceId={B} />);
    fireEvent.click(badge());
    const panel = screen.getByTestId("role-panel");
    expect(within(panel).getByRole("heading", { name: "What each role can do" })).toBeVisible();
    const listed = [...panel.querySelectorAll("[data-action]")].map((el) =>
      el.getAttribute("data-action"),
    );
    expect([...listed].sort()).toEqual(Object.keys(ROLE_ACTIONS).sort());
    for (const row of panel.querySelectorAll("tr[data-action]")) {
      const action = row.getAttribute("data-action") as RoleAction;
      for (const role of WORKSPACE_ROLES) {
        const cell = row.querySelector(`td[data-role="${role}"]`);
        const expected = mayTakeAction(
          { tenantRole: role, platformMaintainer: false, workspaceRoles: { x: role } },
          action,
          "x",
        );
        expect(cell?.getAttribute("data-allowed"), `${action} ${role}`).toBe(String(expected));
      }
    }
    const own = [...panel.querySelectorAll("thead th[data-own]")];
    expect(own.map((th) => th.getAttribute("data-role"))).toEqual(["guest"]);
    expect(own[0]).toHaveTextContent("You");
    // A Guest reads the board and posts on it, and changes no bot.
    const boardPost = panel.querySelector('tr[data-action="board.post"] td[data-role="guest"]');
    expect(boardPost).toHaveAttribute("data-allowed", "true");
    const botCreate = panel.querySelector('tr[data-action="bot.create"] td[data-role="guest"]');
    expect(botCreate).toHaveAttribute("data-allowed", "false");
    expect(within(panel).getByText(/As a Guest you can read shared chats/)).toBeVisible();
    // Actions only the administrator account takes are listed apart.
    expect(
      panel.querySelector('.role-panel-admin [data-action="servicePrincipal.manage"]'),
    ).toHaveTextContent("Manage service principals");
  });

  it("marks the Owner column for the administrator account", () => {
    render(<RoleBadge roles={ROOT} workspaceId={A} />);
    fireEvent.click(badge());
    const panel = screen.getByTestId("role-panel");
    expect(
      [...panel.querySelectorAll("thead th[data-own]")].map((th) => th.getAttribute("data-role")),
    ).toEqual(["owner"]);
    expect(within(panel).getByText(/You are the administrator account/)).toBeVisible();
  });

  it("has words for every action in every locale, so the panel never shows a raw name", () => {
    const missing: string[] = [];
    for (const locale of UI_LOCALES)
      for (const action of Object.keys(ROLE_ACTIONS) as RoleAction[])
        if (!CATALOGS[locale][actionLabelKey(action)]) missing.push(`${locale}: ${action}`);
    expect(missing).toEqual([]);
    // And no words are left for an action the table no longer has.
    const labelled = Object.keys(CATALOGS.en).filter((key) => key.startsWith("roles.action."));
    expect(labelled.sort()).toEqual(
      (Object.keys(ROLE_ACTIONS) as RoleAction[]).map(actionLabelKey).sort(),
    );
  });
});
