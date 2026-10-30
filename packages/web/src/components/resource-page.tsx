// The frame shared by Knowledge, Skills and Computer (issue #27): one page heading with the
// selected workspace as context and at most one primary action, and the state shown when the
// team has no workspace yet. Every one of these pages is scoped by the sidebar's workspace
// switcher and never switches, creates or starts a workspace by being opened.

import { EmptyState, PageHeader } from "@deskmates/ui";
import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n/i18n-provider.js";
import { NextAction, useCan } from "../state/session-roles.js";
import type { WorkspaceScope } from "../state/workspace-scope.js";
import { Button } from "./ui/button.js";

export function ResourceHeading({
  title,
  context,
  action,
  children,
}: {
  title: string;
  /** One line under the title: the workspace and what the page holds. */
  context: ReactNode;
  /** The page's single primary action. */
  action?: ReactNode;
  /** Extra facts under the context line (Computer's bot and domain counts). */
  children?: ReactNode;
}) {
  return (
    <PageHeader title={title} description={context} action={action} className="resource-heading">
      {children}
    </PageHeader>
  );
}

/** What Knowledge, Skills and Computer show before the team has a workspace. */
export function NoWorkspace({ scope }: { scope: WorkspaceScope }) {
  const t = useT();
  const canCreateWorkspace = useCan("workspace.create");
  return (
    <section className="workspace-screen resource-page page-container">
      <EmptyState
        icon={<Monitor size={20} />}
        title={t("workspace.empty.title")}
        action={
          canCreateWorkspace.allowed ? (
            <Button variant="primary" onClick={scope.openCreate}>
              {t("workspace.newWorkspace")}
            </Button>
          ) : undefined
        }
      >
        <div>
          <p className="muted">{t("workspace.empty.intro")}</p>
          {!canCreateWorkspace.allowed ? (
            <NextAction
              action="workspace.create"
              does={t("workspace.empty.nextDoes")}
              how={t("workspace.empty.nextHow")}
            />
          ) : null}
        </div>
      </EmptyState>
    </section>
  );
}
