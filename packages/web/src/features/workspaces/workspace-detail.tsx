// A workspace's full-page detail in User Settings › Workspaces (ADR-0034 decision 4). It is keyed
// by the immutable workspace ID and read from the same authorized directory as the list, so a
// workspace the caller cannot see is "not found" here too. Each block is one section component
// from `detail-sections.ts`; every action keeps its existing route, role and confirmation.

import type { WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage, formatDateTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useWorkspaceScope } from "../../state/workspace-scope.js";
import { type WorkspaceListState, workspacesHref } from "../account/route.js";
import { ApproveAllBadge } from "../approvals/approval-mode.js";
import type { DetailShell } from "./detail-sections.js";
import { ContainerFact } from "./detail/container-fact.js";
import { backToList } from "./list-return.js";
import { useEnterWorkspace } from "./use-enter-workspace.js";
import { WorkspaceSettings } from "./workspace-settings.js";

/** Find one workspace by exact ID among the caller's active, then archived, workspaces. */
async function loadEntry(api: ApiClient, id: string): Promise<WorkspaceDirectoryEntry | undefined> {
  const active = await api.listWorkspaceDirectory({ q: id, limit: 1 });
  const hit = active.workspaces.find((w) => w.id === id);
  if (hit) return hit;
  const archived = await api.listWorkspaceDirectory({ q: id, filter: "archived", limit: 1 });
  return archived.workspaces.find((w) => w.id === id);
}

export function WorkspaceDetail({
  api,
  workspaceId,
  list,
  shell,
}: {
  api: ApiClient;
  workspaceId: string;
  list: WorkspaceListState;
  shell?: DetailShell | undefined;
}) {
  const t = useT();
  const entryAction = useEnterWorkspace(api);
  const scope = useWorkspaceScope(api);
  const [entry, setEntry] = useState<WorkspaceDirectoryEntry | null>();
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    const request = ++sequence.current;
    setError(undefined);
    loadEntry(api, workspaceId)
      .then((found) => {
        if (request === sequence.current) setEntry(found ?? null);
      })
      .catch((err: unknown) => {
        if (request === sequence.current) setError(errorMessage(err));
      });
  }, [api, workspaceId]);
  useEffect(() => {
    setEntry(undefined);
    load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (entry) heading.current?.focus({ preventScroll: true });
  }, [entry]);

  const back = (
    <a className="workspace-detail-back" href={workspacesHref(list)} onClick={backToList}>
      <ChevronLeft size={15} aria-hidden="true" /> {t("workspaceManage.back")}
    </a>
  );
  if (error)
    return (
      <section className="card workspace-detail">
        {back}
        <div role="alert" className="error">
          {t("workspaceManage.error", { error })}{" "}
          <Button type="button" variant="outline" onClick={load}>
            {t("workspaceManage.retry")}
          </Button>
        </div>
      </section>
    );
  if (entry === undefined)
    return (
      <section className="card workspace-detail">
        {back}
        <output>{t("workspaceManage.detail.loading")}</output>
      </section>
    );
  if (entry === null)
    return (
      <section className="card workspace-detail">
        {back}
        <p role="alert">{t("workspaceManage.detail.notFound")}</p>
      </section>
    );
  const isCurrent = scope.current?.id === entry.id;
  return (
    <section className="workspace-detail" aria-labelledby="workspace-detail-title">
      {back}
      <header className="workspace-detail-header">
        <h2 id="workspace-detail-title" ref={heading} tabIndex={-1} title={entry.name}>
          {entry.name}
        </h2>
        <ApproveAllBadge api={api} workspaceId={entry.id} />
        <dl className="workspace-detail-facts">
          <div>
            <dt>{t("workspaceManage.detail.myRole")}</dt>
            <dd>{t(`workspaceManage.role.${entry.myRole}`)}</dd>
          </div>
          <ContainerFact api={api} entry={entry} />
        </dl>
        <details className="workspace-identifier">
          <summary>{t("workspaceManage.detail.id")}</summary>
          <code>{entry.id}</code>
        </details>
        {entry.archivedAt ? (
          <p className="muted">
            {t("workspaceManage.detail.archived", { when: formatDateTime(entry.archivedAt) })}
          </p>
        ) : isCurrent ? (
          <p className="muted">{t("workspaceManage.detail.isCurrent")}</p>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={entryAction.opening !== undefined}
            onClick={() => void entryAction.enter(entry.id)}
          >
            {t("workspaceManage.detail.open")}
          </Button>
        )}
      </header>
      {entryAction.error ? (
        <p role="alert" className="error">
          {entryAction.error}
        </p>
      ) : null}
      <WorkspaceSettings
        key={entry.id}
        api={api}
        entry={entry}
        onChanged={setEntry}
        shell={shell}
      />
    </section>
  );
}
