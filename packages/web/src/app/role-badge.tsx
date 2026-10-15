// The role badge at the top right of the shell (ADR-0022 amendment 7 S8): every signed-in person
// sees their role in the selected workspace, the administrator account as such, and a Guest's
// reads "Guest · read-only". A click opens the role panel (S9). It is a label, never a
// permission: the Gateway decides every action.

import { type SessionRoles, sessionRoleIn } from "@deskmates/contracts";
import { Eye, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogTrigger } from "../components/ui/dialog.js";
import { useT } from "../i18n/i18n-provider.js";
import { type BadgeRole, ROLE_NAME, RolePanel } from "./role-panel.js";

/** The role the badge shows: the root as such, else the role in `workspaceId`. */
export function badgeRole(
  roles: SessionRoles,
  workspaceId: string | undefined,
): BadgeRole | undefined {
  return roles.root === true ? "root" : sessionRoleIn(roles, workspaceId);
}

export function RoleBadge({
  roles,
  workspaceId,
}: {
  roles: SessionRoles;
  /** The selected workspace; undefined before one is chosen. */
  workspaceId: string | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const role = badgeRole(roles, workspaceId);
  const name = role ? t(ROLE_NAME[role]) : t("roles.badge.none");
  const text = role === "guest" ? t("roles.badge.readOnly", { role: name }) : name;
  const Icon = role === "guest" || role === undefined ? Eye : ShieldCheck;
  const label = t("roles.badge.label", { role: text });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="role-badge"
          data-role={role ?? "none"}
          data-testid="role-badge"
          aria-label={label}
          title={label}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{text}</span>
        </button>
      </DialogTrigger>
      {open ? <RolePanel own={role} /> : null}
    </Dialog>
  );
}
