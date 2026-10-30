// Operate › Computer (issue #27; the former Shared computer Settings tab): the infrastructure a
// workspace's bots share. One browser with one login state, one filesystem and one shell; the
// hosts it may reach (ADR-0020); and the bots on it, whose screens and the takeover control are
// on their profiles. Opening this page only reads: it never starts the workspace, takes control
// or changes the allowlist. The allowlist is edited in the workspace's Network policy settings,
// which this page links to.

import type { BotDefinition } from "@deskmates/contracts";
import { isOpenInternetAllowlist } from "@deskmates/contracts";
import { EmptyState } from "@deskmates/ui";
import { Globe, Monitor, SlidersHorizontal, UserRoundPlus } from "lucide-react";
import { useEffect } from "react";
import type { ApiClient } from "../../api/client.js";
import { NoWorkspace, ResourceHeading } from "../../components/resource-page.js";
import { Avatar } from "../../components/ui/avatar.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { contactHref } from "../../router.js";
import { useRememberBots } from "../../state/bot-avatars.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { workspaceDetailHref } from "../account/route.js";
import { WorkspaceArchive } from "./workspace-archive.js";

/** Bots per page on the Computer page (#113 slice D, plan row 41). */
export const COMPUTER_BOT_PAGE_SIZE = 25;

export function ComputerScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const scope = useWorkspaceScope(api);
  const workspace = scope.current;
  const rememberBots = useRememberBots();
  // #113 slice D: one page of this workspace's bots (25, by name) with the Gateway's total,
  // instead of every bot of the tenant.
  const pages = usePagedQuery<BotDefinition>({
    scopeKey: `computer.bots:${workspace?.id ?? ""}`,
    limit: COMPUTER_BOT_PAGE_SIZE,
    mode: "offset",
    historyKey: "computer.bots",
    fetchPage: async ({ offset, limit }) => {
      if (!workspace) return { items: [], total: 0 };
      const page = await api.listBotPage(workspace.id, { offset, limit });
      return { items: page.bots, total: page.total };
    },
  });
  const members = pages.items;
  const loaded = pages.page !== undefined || pages.error !== undefined;
  const error = pages.error ? errorMessage(pages.error) : undefined;
  const total = pages.page?.total ?? members.length;
  useEffect(() => {
    if (members.length > 0) rememberBots(members);
  }, [members, rememberBots]);
  const name = workspace?.name ?? t("workspace.thisWorkspace");

  return (
    <section className="workspace-screen computer-page page-container">
      {scope.loaded && !workspace ? (
        <NoWorkspace scope={scope} />
      ) : (
        <div className="resource-page computer-content">
          <ResourceHeading title={t("computer.title")} context={t("computer.context", { name })}>
            {workspace ? (
              <p className="resource-heading-facts">
                {pages.page ? (
                  <Pill tone="neutral">{t("workspace.botCount", { count: total })}</Pill>
                ) : null}
                {isOpenInternetAllowlist(workspace.egressAllowlist) ? (
                  <Pill tone="warning" title={t("workspace.openInternet.title")}>
                    <Globe size={12} /> {t("workspace.openInternet.label")}
                  </Pill>
                ) : (
                  <Pill tone="neutral" title={workspace.egressAllowlist.join(", ")}>
                    <Globe size={12} />{" "}
                    {t("workspace.allowedDomains", { count: workspace.egressAllowlist.length })}
                  </Pill>
                )}
              </p>
            ) : null}
          </ResourceHeading>

          {workspace ? (
            <div className="workspace-settings">
              <section className="card" aria-label={t("computer.desktops.title")}>
                <h2>{t("computer.desktops.title")}</h2>
                <p className="muted small">{t("computer.desktops.intro")}</p>
                {error ? (
                  <div role="alert" className="error">
                    {error}{" "}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pages.loading}
                      onClick={() => pages.reload()}
                    >
                      {t("desktopRail.retry")}
                    </Button>
                  </div>
                ) : !loaded ? (
                  <p className="muted small">{t("computer.desktops.loading")}</p>
                ) : members.length === 0 ? (
                  <EmptyState icon={<Monitor size={20} />} title={t("workspace.settings.noBots")} />
                ) : (
                  <ul className="info-members computer-bots">
                    {members.map((b) => (
                      <li key={b.id} className="workspace-bot-row">
                        <Avatar name={b.name} size="sm" />
                        <span className="computer-bot-name">
                          <strong>{b.name}</strong>
                          <span className="muted small">{b.role}</span>
                        </span>
                        <a
                          href={contactHref(b.id)}
                          className="computer-bot-link"
                          aria-label={t("computer.desktops.openNamed", { name: b.name })}
                        >
                          <Monitor size={14} aria-hidden="true" /> {t("computer.desktops.open")}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                <PageBar query={pages} label={t("computer.desktops.pages")} />
                <p className="muted small">{t("workspace.settings.botsNote")}</p>
                <ButtonLink variant="tertiary" href="#/contacts">
                  <UserRoundPlus size={15} /> {t("workspace.settings.addBotShort")}
                </ButtonLink>
              </section>
              <section className="card workspace-definition">
                <h2>{t("workspace.settings.about", { name: workspace.name })}</h2>
                <p className="muted small">{t("workspace.settings.aboutShort")}</p>
              </section>
              <section className="card">
                <h2>{t("workspace.settings.allowedDomains")}</h2>
                <p className="muted small">
                  {t.rich("workspace.settings.domainsShort", {
                    code: (text) => <code>{text}</code>,
                  })}
                </p>
                {/* The list is edited in one place, the workspace's Network policy. */}
                <ButtonLink variant="tertiary" href={workspaceDetailHref(workspace.id)}>
                  <SlidersHorizontal size={15} /> {t("computer.allowedDomains.manage")}
                </ButtonLink>
              </section>
            </div>
          ) : null}
        </div>
      )}
      <WorkspaceArchive api={api} scope={scope} />
    </section>
  );
}
