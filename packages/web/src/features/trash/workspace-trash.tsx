import type { Workspace } from "@deskmates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { computerHref } from "../../router.js";
import { useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";

/** Archived workspaces: 25 a page (#113). */
export const TRASH_PAGE_SIZE = 25;

export function WorkspaceTrashScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const allowed = useCan("trash.view").allowed;
  // Do not mount readers for a Member, even when they follow a saved Trash URL.
  return allowed ? (
    <AuthorizedTrash api={api} />
  ) : (
    <section className="workspace-screen resource-page page-container">
      <h1>{t("workspaceTrash.title")}</h1>
      <p role="alert">{t("workspaceTrash.denied")}</p>
      <ButtonLink href="#/threads" variant="primary">
        {t("app.missing.home")}
      </ButtonLink>
    </section>
  );
}

function AuthorizedTrash({ api }: { api: ApiClient }) {
  const t = useT();
  const scope = useWorkspaceScope(api);
  // One page of archived workspaces, newest first, with the honest total (#113). The hook
  // discards an answer begun before a later reload, and steps back when a restore empties the
  // last page.
  const pages = usePagedQuery<Workspace>({
    scopeKey: "trash.workspaces",
    limit: TRASH_PAGE_SIZE,
    mode: "offset",
    historyKey: "trash.workspaces",
    fetchPage: async ({ offset, limit }) => {
      const trash = await api.listTrash({ offset, limit });
      return {
        items: trash.workspaces.filter((workspace) => workspace.archivedAt),
        total: trash.total ?? trash.workspaces.length,
      };
    },
  });
  // A restored row leaves at once, before the reloaded page arrives.
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const rows = pages.items.filter((workspace) => !restored.has(workspace.id));
  const loaded = pages.page !== undefined;
  const loading = pages.loading;
  const error = pages.error ? errorMessage(pages.error) : undefined;
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const running = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const reloadPage = pages.reload;
  const reload = useCallback(async () => reloadPage(), [reloadPage]);
  useEffect(() => {
    generation.current++;
    running.current = false;
    setBusy(undefined);
    setActionError(undefined);
    setNotice(undefined);
    heading.current?.focus({ preventScroll: true });
    const online = () => void reload();
    window.addEventListener("online", online);
    const stop = subscribeEvents({
      onReconnect: online,
      onEvent: (event) => {
        if (event.type === "workspace") void reload();
      },
    });
    return () => {
      generation.current++;
      window.removeEventListener("online", online);
      stop();
    };
  }, [reload]);
  const restore = async (workspace: Workspace) => {
    if (running.current) return;
    running.current = true;
    setBusy(workspace.id);
    setActionError(undefined);
    setNotice(undefined);
    const request = generation.current;
    try {
      const restored = await api.restoreWorkspace(workspace.id);
      if (request !== generation.current) return;
      // The reload below supersedes any page begun before this mutation completed.
      setRestored((ids) => new Set(ids).add(workspace.id));
      scope.add(restored);
      setNotice(t("workspaceTrash.restored", { name: restored.name }));
      heading.current?.focus({ preventScroll: true });
      void reload();
    } catch (err) {
      if (request === generation.current) setActionError(errorMessage(err));
    } finally {
      if (request === generation.current) {
        running.current = false;
        setBusy(undefined);
      }
    }
  };
  return (
    <section className="workspace-screen resource-page page-container workspace-trash-page">
      <header className="resource-heading">
        <div className="resource-heading-text">
          <h1 ref={heading} tabIndex={-1}>
            {t("workspaceTrash.title")}
          </h1>
          <p>{t("workspaceTrash.intro")}</p>
        </div>
        <Button disabled={loading || !!busy} onClick={() => void reload()}>
          {error ? t("workspaceTrash.retry") : t("workspaceTrash.refresh")}
        </Button>
      </header>
      <p>{t("workspaceTrash.restoreNote")}</p>
      {notice ? (
        <output>
          {notice} <a href={computerHref()}>{t("workspaceTrash.openComputer")}</a>
        </output>
      ) : null}
      {actionError ? (
        <p role="alert" className="error">
          {actionError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {loading ? <output>{t("workspaceTrash.loading")}</output> : null}
      {loaded && !loading && !error && rows.length === 0 ? (
        <p>{t("workspaceTrash.empty")}</p>
      ) : null}
      <div className="management-grid">
        {rows.map((workspace) => (
          <article className="card" key={workspace.id}>
            <h2>{workspace.name}</h2>
            <p className="muted small">
              {t("workspaceTrash.archivedAt", { date: formatDateTime(workspace.archivedAt ?? "") })}
            </p>
            <Button
              disabled={!!busy}
              aria-label={t("workspaceTrash.restoreNamed", { name: workspace.name })}
              onClick={() => void restore(workspace)}
            >
              {busy === workspace.id ? t("workspaceTrash.restoring") : t("workspaceTrash.restore")}
            </Button>
          </article>
        ))}
      </div>
      <PageBar query={pages} label={t("workspaceTrash.pages")} />
      <ButtonLink href={computerHref()} variant="tertiary">
        {t("workspaceTrash.back")}
      </ButtonLink>
    </section>
  );
}
