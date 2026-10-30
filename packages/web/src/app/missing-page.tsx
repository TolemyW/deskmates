import type { ActionRole } from "@deskmates/contracts";
import { CircleSlash2, FileQuestion } from "lucide-react";
import { ButtonLink } from "../components/ui/button.js";
import type { MessageKey } from "../i18n/catalogs.js";
import { useT } from "../i18n/i18n-provider.js";

const ROLE_LABEL: Readonly<Record<ActionRole, MessageKey>> = {
  guest: "roles.who.guest",
  member: "roles.who.member",
  admin: "roles.who.admin",
  owner: "roles.who.owner",
  platform: "roles.who.platform",
  root: "roles.who.root",
};

export function MissingPage({ path }: { path?: string }) {
  const t = useT();
  return (
    <section className="terminal-page page-container" data-testid="page-not-found">
      <FileQuestion size={32} aria-hidden="true" />
      <h1>{t("app.missing.page.title")}</h1>
      <p>{t("app.missing.page.body", { path: path || "#/" })}</p>
      <ButtonLink variant="primary" href="#/threads">
        {t("app.missing.home")}
      </ButtonLink>
    </section>
  );
}

export function ForbiddenPage({ role }: { role: ActionRole }) {
  const t = useT();
  const roleName = t(ROLE_LABEL[role]);
  return (
    <section className="terminal-page page-container" data-testid="page-forbidden">
      <CircleSlash2 size={32} aria-hidden="true" />
      <h1>{t("app.missing.forbidden.title")}</h1>
      <p>{t("app.missing.forbidden.body", { role: roleName })}</p>
      <p className="muted">{t("app.missing.forbidden.ask", { role: roleName })}</p>
      <ButtonLink variant="primary" href="#/threads">
        {t("app.missing.home")}
      </ButtonLink>
    </section>
  );
}
