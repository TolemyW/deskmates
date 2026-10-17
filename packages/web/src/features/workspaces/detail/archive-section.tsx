// Detail › Archive (ADR-0026, ADR-0034 decision 9), in place: an Admin or Owner archives after the
// same confirmation as the Computer page (what stops, what is kept, how to restore), and restores
// an archived workspace here. Permanent deletion stays in Trash behind its typed-name check.

import { useRef, useState } from "react";
import { Button, ButtonLink } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { errorMessage } from "../../../format.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { trashHref } from "../../../router.js";
import { useCan } from "../../../state/session-roles.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import type { DetailSectionProps } from "../detail-sections.js";

export function ArchiveSection({ api, entry, onChanged }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  const canArchive = useCan("workspace.archive", entry.id).allowed;
  const canRestore = useCan("workspace.restore", entry.id).allowed;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const archived = Boolean(entry.archivedAt);
  if (archived ? !canRestore : !canArchive) return null;

  const archive = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await api.archiveWorkspace(entry.id);
      scope?.update(workspace);
      setConfirming(false);
      setNotice(t("workspaceManage.archive.archived"));
      onChanged({ ...entry, archivedAt: workspace.archivedAt ?? new Date().toISOString() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await api.restoreWorkspace(entry.id);
      scope?.add(workspace);
      setNotice(t("workspaceManage.archive.restored"));
      const { archivedAt: _archivedAt, ...active } = entry;
      onChanged(active);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-archive-title">
      <h3 id="workspace-archive-title">{t("workspaceManage.archive.title")}</h3>
      <p className="muted small">
        {archived ? t("workspaceManage.archive.archivedBody") : t("workspaceManage.archive.body")}
      </p>
      {notice ? <output className="small">{notice}</output> : null}
      {error && !confirming ? (
        <p role="alert" className="error small">
          {t("workspaceManage.archive.failed", { error })}
        </p>
      ) : null}
      <div className="form-actions">
        {archived ? (
          <>
            <Button type="button" disabled={busy} onClick={() => void restore()}>
              {busy ? t("workspaceManage.archive.restoring") : t("workspaceManage.archive.restore")}
            </Button>
            <ButtonLink href={trashHref()} variant="tertiary">
              {t("workspaceManage.archive.trash")}
            </ButtonLink>
          </>
        ) : (
          <Button
            ref={trigger}
            type="button"
            variant="destructive"
            onClick={() => {
              setError(undefined);
              setNotice(undefined);
              setConfirming(true);
            }}
          >
            {t("workspaceTrash.archive")}
          </Button>
        )}
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(false);
        }}
      >
        <DialogContent
          className="max-w-lg overflow-y-auto"
          closeLabel={t("workspaceTrash.closeConfirmation")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <DialogTitle className="pr-8 text-lg font-semibold">
            {t("workspaceTrash.confirmTitle", { name: entry.name })}
          </DialogTitle>
          <DialogDescription className="mt-2">{t("workspaceTrash.consequences")}</DialogDescription>
          <p className="mt-2">{t("workspaceTrash.retained")}</p>
          <p className="mt-2">{t("workspaceTrash.restoreNote")}</p>
          {error ? (
            <p role="alert" className="error">
              {t("workspaceTrash.archiveFailed", { error })}
            </p>
          ) : null}
          <div className="form-actions workspace-archive-actions mt-4">
            <Button ref={cancel} disabled={busy} onClick={() => setConfirming(false)}>
              {t("workspaceTrash.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void archive()}>
              {busy
                ? t("workspaceTrash.archiving")
                : error
                  ? t("workspaceTrash.retryArchive")
                  : t("workspaceTrash.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
