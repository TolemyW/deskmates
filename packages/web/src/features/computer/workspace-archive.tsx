import type { Workspace } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button, ButtonLink } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { navigate, trashHref } from "../../router.js";
import { useCan } from "../../state/session-roles.js";
import type { WorkspaceScope } from "../../state/workspace-scope.js";

/** Keep the operation mounted even when the archive event removes the selected workspace.
 * The Gateway emits that event before sandbox cleanup, which can still fail and need retry. */
export function WorkspaceArchive({ api, scope }: { api: ApiClient; scope: WorkspaceScope }) {
  const t = useT();
  const allowed = useCan("workspace.archive").allowed;
  const [target, setTarget] = useState<Workspace>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const generation = useRef(0);
  const previousApi = useRef(api);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    generation.current++;
    if (previousApi.current !== api) {
      previousApi.current = api;
      running.current = false;
      setBusy(false);
      setTarget(undefined);
      setError(undefined);
    }
    return () => {
      generation.current++;
    };
  }, [api]);
  const archive = async () => {
    if (!target || !allowed || running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    const request = generation.current;
    try {
      const archived = await api.archiveWorkspace(target.id);
      if (request !== generation.current) return;
      scope.update(archived);
      setTarget(undefined);
      navigate(trashHref());
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      if (request === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  if (!allowed) return null;
  return (
    <>
      <section className="card workspace-lifecycle">
        <h2>{t(scope.current ? "workspaceTrash.lifecycle" : "workspaceTrash.title")}</h2>
        <div className="form-actions">
          {scope.current ? (
            <Button
              ref={trigger}
              variant="destructive"
              onClick={() => {
                setError(undefined);
                setTarget(scope.current);
              }}
            >
              {t("workspaceTrash.archive")}
            </Button>
          ) : null}
          <ButtonLink href={trashHref()} variant="tertiary">
            {t("workspaceTrash.title")}
          </ButtonLink>
        </div>
      </section>
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !running.current) setTarget(undefined);
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
            {t("workspaceTrash.confirmTitle", { name: target?.name ?? "" })}
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
            <Button ref={cancel} disabled={busy} onClick={() => setTarget(undefined)}>
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
    </>
  );
}
