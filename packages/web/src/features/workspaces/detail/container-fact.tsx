// The "Container" line of a workspace's detail page (issue #15): whether the sandbox exists, in
// words, and what a message in its chats would do. `status` (`ready`) never says this; the
// Gateway's `container` does, read with `peek`, which never starts a machine. An archived
// workspace is not served by `GET /api/workspaces/:id`: moving it to Trash removed its container.

import type { Workspace, WorkspaceDirectoryEntry } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../../api/client.js";
import type { WorkspaceView } from "../../../api/types.js";
import type { MessageKey } from "../../../i18n/catalogs.js";
import { useT } from "../../../i18n/i18n-provider.js";

type Loaded = { view: WorkspaceView } | { failed: true } | undefined;

/** The sentences of the line: the container state, then anything unusual the row records. */
export function containerSentences(
  entry: Pick<WorkspaceDirectoryEntry, "archivedAt">,
  view:
    | (Pick<WorkspaceView, "container"> & {
        workspace: Pick<Workspace, "status" | "restorationRequirements">;
      })
    | undefined,
): { key: MessageKey; values?: Record<string, number> }[] {
  if (entry.archivedAt) return [{ key: "workspaceManage.container.archived" }];
  if (!view?.container) return [];
  const out: { key: MessageKey; values?: Record<string, number> }[] = [
    { key: `workspaceManage.container.${view.container}` },
  ];
  const status = view.workspace.status;
  if (status !== "ready") out.push({ key: `workspaceManage.container.status.${status}` });
  // `at_risk` is about the container that is there now; the others survive a replacement.
  const pending = (view.workspace.restorationRequirements ?? []).filter(
    (r) => r.status !== "at_risk",
  ).length;
  if (pending > 0)
    out.push({ key: "workspaceManage.container.restoration", values: { count: pending } });
  return out;
}

export function ContainerFact({ api, entry }: { api: ApiClient; entry: WorkspaceDirectoryEntry }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    if (entry.archivedAt) return;
    let active = true;
    setLoaded(undefined);
    api
      .getWorkspace(entry.id)
      .then((view) => {
        if (active) setLoaded({ view });
      })
      .catch(() => {
        if (active) setLoaded({ failed: true });
      });
    return () => {
      active = false;
    };
  }, [api, entry.id, entry.archivedAt]);

  const view = loaded && "view" in loaded ? loaded.view : undefined;
  const sentences = containerSentences(entry, view);
  // An older Gateway that does not report the container, or a failed read: no line at all.
  if (sentences.length === 0 && loaded !== undefined) return null;
  return (
    <div data-testid="workspace-container">
      <dt>{t("workspaceManage.container.label")}</dt>
      <dd>
        {sentences.length === 0
          ? t("workspaceManage.container.loading")
          : sentences.map((s) => t(s.key, s.values)).join(" ")}
      </dd>
    </div>
  );
}
