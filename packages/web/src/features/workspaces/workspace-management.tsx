// User Settings › Workspaces (ADR-0034 decision 4, issue #117): a dense list of the caller's
// workspaces, 20 a page from the server, with name search, All/Pinned/Archived, My role, the
// authorized total and a permission-aware New. A row's name opens the workspace's full-page detail;
// "Back to workspace list" returns to the same search, filters and page. Search and filters live
// in the address, the page in history state (`usePagedQuery`).

import {
  TENANT_ROLES,
  type TenantRole,
  WORKSPACE_DIRECTORY_FILTERS,
  WORKSPACE_DIRECTORY_PAGE,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectoryFilter,
} from "@deskmates/contracts";
import { Pager } from "@deskmates/ui";
import { Pin, PinOff, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { useCan } from "../../state/session-roles.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { type WorkspaceListState, workspaceDetailHref, workspacesHref } from "../account/route.js";
import type { DetailShell } from "./detail-sections.js";
import { markOpenedFromList } from "./list-return.js";
import { useEnterWorkspace } from "./use-enter-workspace.js";
import { WorkspaceDetail } from "./workspace-detail.js";

const SEARCH_DELAY_MS = 250;
export const WORKSPACE_LIST_HISTORY_KEY = "workspaces.directory";

export function WorkspaceManagement({
  api,
  list = {},
  workspaceId,
  shell,
}: {
  api: ApiClient;
  list?: WorkspaceListState;
  workspaceId?: string;
  /** The people client and session the detail's People section edits with. */
  shell?: DetailShell;
}) {
  if (workspaceId)
    return <WorkspaceDetail api={api} workspaceId={workspaceId} list={list} shell={shell} />;
  return <WorkspaceList api={api} list={list} />;
}

function WorkspaceList({ api, list }: { api: ApiClient; list: WorkspaceListState }) {
  const t = useT();
  const entryAction = useEnterWorkspace(api);
  const scope = useWorkspaceScope(api);
  const canCreate = useCan("workspace.create").allowed;
  const [text, setText] = useState(list.q ?? "");
  const [q, setQ] = useState(list.q ?? "");
  const [filter, setFilter] = useState<WorkspaceDirectoryFilter>(list.filter ?? "all");
  const [role, setRole] = useState<TenantRole | undefined>(list.role);
  const [pinError, setPinError] = useState<string>();
  const [pinned, setPinned] = useState<ReadonlyMap<string, boolean>>(new Map());
  const heading = useRef<HTMLHeadingElement>(null);
  const pinRequests = useRef(new Set<string>());
  const [pendingPins, setPendingPins] = useState<ReadonlySet<string>>(new Set());

  // A real navigation (Back to list, a link) brings its own search and filters.
  const listKey = JSON.stringify(list);
  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey stands for list.
  useEffect(() => {
    setText(list.q ?? "");
    setQ(list.q ?? "");
    setFilter(list.filter ?? "all");
    setRole(list.role);
  }, [listKey]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const state = useMemo<WorkspaceListState>(
    () => ({
      ...(q ? { q } : {}),
      ...(filter !== "all" ? { filter } : {}),
      ...(role ? { role } : {}),
    }),
    [q, filter, role],
  );
  // Keep the address in step without a new history entry, so reload and Back keep the list.
  useEffect(() => {
    const href = workspacesHref(state);
    if (window.location.hash !== href) window.history.replaceState(window.history.state, "", href);
  }, [state]);

  const scopeKey = JSON.stringify(state);
  const pages = usePagedQuery<WorkspaceDirectoryEntry>({
    scopeKey,
    limit: WORKSPACE_DIRECTORY_PAGE.default,
    mode: "offset",
    historyKey: WORKSPACE_LIST_HISTORY_KEY,
    fetchPage: async ({ offset, limit }) => {
      const page = await api.listWorkspaceDirectory({ ...state, offset, limit });
      return { items: page.workspaces, total: page.total };
    },
  });
  // A directory refresh must not erase an optimistic pin whose request is still pending.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile overrides when the page changes.
  useEffect(() => {
    setPinned((current) => new Map([...current].filter(([id]) => pinRequests.current.has(id))));
  }, [pages.page]);

  const togglePin = async (entry: WorkspaceDirectoryEntry) => {
    if (pinRequests.current.has(entry.id)) return;
    pinRequests.current.add(entry.id);
    setPendingPins(new Set(pinRequests.current));
    const next = !(pinned.get(entry.id) ?? entry.pinned);
    setPinError(undefined);
    setPinned((map) => new Map(map).set(entry.id, next));
    try {
      await api.setWorkspacePinned(entry.id, next);
      if (filter === "pinned") pages.reload();
    } catch (err) {
      setPinned((map) => new Map(map).set(entry.id, !next));
      setPinError(t("workspaceManage.pinFailed", { error: errorMessage(err) }));
    } finally {
      pinRequests.current.delete(entry.id);
      setPendingPins(new Set(pinRequests.current));
    }
  };

  const range = pages.range;
  const total = pages.page?.total;
  const error = pages.error ? errorMessage(pages.error) : undefined;
  const filtered = q !== "" || filter !== "all" || role !== undefined;
  return (
    <section className="card workspace-manage" aria-labelledby="workspace-manage-title">
      <header className="workspace-manage-header">
        <h2 id="workspace-manage-title" ref={heading} tabIndex={-1}>
          {total === undefined
            ? t("workspaceManage.title")
            : t("workspaceManage.total", { count: total })}
        </h2>
        <Button
          type="button"
          variant="default"
          disabled={!canCreate}
          title={canCreate ? undefined : t("workspaceManage.newDenied")}
          onClick={() => scope.openCreate()}
        >
          <Plus size={15} aria-hidden="true" /> {t("workspaceManage.new")}
        </Button>
      </header>
      <div className="workspace-manage-filters">
        <label className="workspace-manage-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={text}
            maxLength={64}
            onChange={(event) => setText(event.target.value)}
            aria-label={t("workspaceManage.searchLabel")}
            placeholder={t("workspaceManage.searchPlaceholder")}
          />
        </label>
        <fieldset className="workspace-manage-segments">
          <legend className="sr-only">{t("workspaceManage.filterLabel")}</legend>
          {WORKSPACE_DIRECTORY_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={`workspace-manage-segment${filter === value ? " active" : ""}`}
              onClick={() => setFilter(value)}
            >
              {t(`workspaceManage.filter.${value}`)}
            </button>
          ))}
        </fieldset>
        <label className="workspace-manage-role">
          <span>{t("workspaceManage.roleLabel")}</span>
          <select
            value={role ?? ""}
            onChange={(event) =>
              setRole(event.target.value ? (event.target.value as TenantRole) : undefined)
            }
          >
            <option value="">{t("workspaceManage.role.any")}</option>
            {TENANT_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`workspaceManage.role.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entryAction.error ? (
        <p role="alert" className="error small">
          {entryAction.error}
        </p>
      ) : null}
      {pinError ? (
        <p role="alert" className="error small">
          {pinError}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="error">
          {t("workspaceManage.error", { error })}{" "}
          <Button type="button" variant="outline" onClick={() => pages.reload()}>
            {t("workspaceManage.retry")}
          </Button>
        </div>
      ) : null}
      {pages.loading && !pages.page ? <output>{t("workspaceManage.loading")}</output> : null}
      {pages.page && pages.items.length === 0 ? (
        <p className="muted">
          {filtered ? t("workspaceManage.noMatches") : t("workspaceManage.empty")}
        </p>
      ) : null}
      {pages.items.length > 0 ? (
        <div className="workspace-manage-table-wrap">
          <table className="workspace-manage-table" aria-busy={pages.loading}>
            <thead>
              <tr>
                <th scope="col" className="workspace-manage-pin-col">
                  <span className="sr-only">{t("workspaceManage.col.pin")}</span>
                </th>
                <th scope="col">{t("workspaceManage.col.name")}</th>
                <th scope="col">{t("workspaceManage.col.role")}</th>
                <th scope="col" className="num">
                  {t("workspaceManage.col.bots")}
                </th>
                <th scope="col" className="num">
                  {t("workspaceManage.col.running")}
                </th>
                <th scope="col">{t("workspaceManage.col.activity")}</th>
                <th scope="col" className="workspace-manage-actions">
                  <span className="sr-only">{t("workspaceManage.col.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pages.items.map((entry) => {
                const isPinned = pinned.get(entry.id) ?? entry.pinned;
                return (
                  <tr key={entry.id}>
                    <td className="workspace-manage-pin-col">
                      {entry.archivedAt ? null : (
                        <button
                          type="button"
                          className="workspace-manage-pin"
                          aria-pressed={isPinned}
                          disabled={pendingPins.has(entry.id)}
                          aria-busy={pendingPins.has(entry.id)}
                          aria-label={t(
                            isPinned ? "workspaceManage.unpin" : "workspaceManage.pin",
                            { name: entry.name },
                          )}
                          onClick={() => void togglePin(entry)}
                        >
                          {isPinned ? (
                            <Pin size={14} aria-hidden="true" />
                          ) : (
                            <PinOff size={14} aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </td>
                    <td className="workspace-manage-name-cell">
                      <a
                        href={workspaceDetailHref(entry.id, state)}
                        className="workspace-manage-name"
                        title={entry.name}
                        onClick={() => {
                          markOpenedFromList();
                        }}
                      >
                        {entry.name}
                      </a>
                      {entry.id === scope.current?.id ? (
                        <span className="workspace-manage-badge">
                          {t("workspaceManage.current")}
                        </span>
                      ) : null}
                    </td>
                    <td data-label={t("workspaceManage.col.role")}>
                      {t(`workspaceManage.role.${entry.myRole}`)}
                    </td>
                    <td className="num" data-label={t("workspaceManage.col.bots")}>
                      {entry.botCount}
                    </td>
                    <td className="num" data-label={t("workspaceManage.col.running")}>
                      {entry.activeRuns === null ? (
                        <span title={t("workspaceManage.runningHidden")}>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">{t("workspaceManage.runningHidden")}</span>
                        </span>
                      ) : (
                        entry.activeRuns
                      )}
                    </td>
                    <td data-label={t("workspaceManage.col.activity")}>
                      <time
                        dateTime={entry.lastActivityAt}
                        title={formatDateTime(entry.lastActivityAt)}
                      >
                        {formatRelative(entry.lastActivityAt)}
                      </time>
                    </td>
                    <td className="workspace-manage-actions">
                      {!entry.archivedAt ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={t("workspaceManage.enterNamed", { name: entry.name })}
                          disabled={entryAction.opening !== undefined}
                          onClick={() => void entryAction.enter(entry.id)}
                        >
                          {t("workspaceManage.enter")}
                        </Button>
                      ) : null}
                      <a
                        href={workspaceDetailHref(entry.id, state)}
                        aria-label={t("workspaceManage.settingsNamed", { name: entry.name })}
                        onClick={markOpenedFromList}
                      >
                        {t("workspaceManage.settings")}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {range ? (
        <Pager
          label={t("workspaceManage.pages")}
          previousLabel={t("workspaceManage.previous")}
          nextLabel={t("workspaceManage.next")}
          range={t("workspaceManage.range", {
            from: range.from,
            to: range.to,
            total: range.total ?? range.to,
          })}
          hasPrevious={pages.hasPrevious}
          hasNext={pages.hasNext}
          onPrevious={pages.previous}
          onNext={pages.next}
          busy={pages.loading}
        />
      ) : null}
    </section>
  );
}
