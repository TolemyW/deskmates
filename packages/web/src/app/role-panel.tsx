// What each role may do (ADR-0022 amendment 7 S9), opened from the role badge. The rows are
// `roleActionMatrix()`, read from `ROLE_ACTIONS`, which the Gateway's `role-actions.test.ts` holds
// to the route policy; nothing here is a hand-written list of permissions. Each action's words are
// `roles.action.<action>` in the catalog; `role-badge.test.tsx` fails for an action without them.

import {
  type RoleAction,
  type TenantRole,
  WORKSPACE_ROLES,
  roleActionMatrix,
} from "@deskmates/contracts";
import { Check, Minus } from "lucide-react";
import { useMemo } from "react";
import { DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.js";
import { CATALOGS, type MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";

/** A workspace role, or the administrator account, as the badge and the panel name it. */
export type BadgeRole = TenantRole | "root";

export const ROLE_NAME: Readonly<Record<BadgeRole, MessageKey>> = {
  owner: "roles.badge.role.owner",
  admin: "roles.badge.role.admin",
  member: "roles.badge.role.member",
  guest: "roles.badge.role.guest",
  root: "roles.badge.role.root",
};

/** The catalog key of an action's words. */
export function actionLabelKey(action: RoleAction): string {
  return `roles.action.${action}`;
}

export function RolePanel({ own }: { own: BadgeRole | undefined }) {
  const t = useT();
  const matrix = useMemo(roleActionMatrix, []);
  // The administrator account is Owner of every workspace (amendment 6 W2).
  const ownColumn = own === "root" ? "owner" : own;
  const label = (action: RoleAction) => {
    const key = actionLabelKey(action);
    return CATALOGS.en[key] === undefined ? action : t(key as MessageKey);
  };
  return (
    <DialogContent className="role-panel w-[min(96vw,760px)]" data-testid="role-panel">
      <DialogTitle className="role-panel-title">{t("roles.panel.title")}</DialogTitle>
      <DialogDescription className="muted small">{t("roles.panel.intro")}</DialogDescription>
      {own === "guest" ? <p className="role-panel-note">{t("roles.panel.guestIntro")}</p> : null}
      {own === "root" ? <p className="role-panel-note">{t("roles.panel.rootIntro")}</p> : null}
      <div className="role-panel-scroll">
        <table className="role-panel-table">
          <thead>
            <tr>
              <th scope="col">{t("roles.panel.action")}</th>
              {WORKSPACE_ROLES.map((role) => (
                <th
                  key={role}
                  scope="col"
                  data-role={role}
                  data-own={role === ownColumn || undefined}
                >
                  {t(ROLE_NAME[role])}
                  {role === ownColumn ? (
                    <span className="role-panel-you">{t("roles.panel.you")}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.workspace.map((row) => (
              <tr key={row.action} data-action={row.action}>
                <th scope="row">
                  {label(row.action)}
                  {row.limitedBelow ? (
                    <span className="role-panel-limited muted small">
                      {t("roles.panel.limitedBelow")}
                    </span>
                  ) : null}
                </th>
                {WORKSPACE_ROLES.map((role) => (
                  <td
                    key={role}
                    data-role={role}
                    data-own={role === ownColumn || undefined}
                    data-allowed={row.allowed[role]}
                  >
                    {row.allowed[role] ? (
                      <Check size={16} role="img" aria-label={t("roles.panel.allowed")} />
                    ) : (
                      <Minus size={16} role="img" aria-label={t("roles.panel.notAllowed")} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="role-panel-subtitle">{t("roles.panel.administrator")}</h3>
        <ul className="role-panel-admin" data-own={own === "root" || undefined}>
          {matrix.administrator.map((action) => (
            <li key={action} data-action={action}>
              {label(action)}
            </li>
          ))}
        </ul>
      </div>
    </DialogContent>
  );
}
