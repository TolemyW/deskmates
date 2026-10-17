// Delete an uploaded file from Files (ADR-0014 amendment A5 decision 43). Any Admin or Owner of the
// workspace may delete a file a person uploaded, whoever uploaded it; the control asks once before
// it acts. Hiding it from a Member or Guest is presentation only: the Gateway refuses them.

import type { WorkspaceFileItem, WorkspaceId } from "@deskmates/contracts";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";

/** The upload behind a Files item, when a person uploaded it. */
export function uploadIdOf(item: WorkspaceFileItem): string | undefined {
  return item.references.find((ref) => ref.kind === "upload" && ref.uploadId)?.uploadId;
}

export function UploadDeleteControl({
  api,
  workspaceId,
  item,
  onDeleted,
}: {
  api: Pick<ApiClient, "deleteWorkspaceUploadFile">;
  workspaceId: WorkspaceId;
  item: WorkspaceFileItem;
  onDeleted: () => void;
}) {
  const t = useT();
  const can = useCan("files.deleteUpload", workspaceId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadId = uploadIdOf(item);
  if (uploadId === undefined || !can.allowed) return null;
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteWorkspaceUploadFile(workspaceId, uploadId);
      setConfirming(false);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="files-upload-delete">
      {confirming ? (
        <div role="alert" className="files-upload-delete-confirm">
          <p>{t("files.delete.confirm", { name: item.name })}</p>
          <div className="form-actions">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? t("files.delete.deleting") : t("files.delete.confirmButton")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              {t("files.delete.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" /> {t("files.delete.button")}
        </Button>
      )}
      {error ? (
        <p role="alert" className="error small">
          {t("files.delete.failed", { error })}
        </p>
      ) : null}
    </div>
  );
}
