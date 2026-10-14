// Detail › Name: rename through `PATCH /api/workspaces/:id` (`workspace.configure`, Admin) with the
// weighted counter (ADR-0034 decisions 1 and 2). A stored legacy name over the bound is shown in
// full and stays until someone renames it.

import { workspaceNameProblem } from "@deskmates/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { errorMessage } from "../../../format.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { useCan } from "../../../state/session-roles.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import type { DetailSectionProps } from "../detail-sections.js";
import {
  WorkspaceNameField,
  submittedWorkspaceName,
  workspaceNameAcceptable,
} from "../workspace-name-field.js";

export function NameSection({ api, entry, onChanged }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  const can = useCan("workspace.configure", entry.id);
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(entry.name);
    setError(undefined);
  }, [entry.name]);
  const legacy = workspaceNameProblem(entry.name)?.code === "too_long";
  const next = submittedWorkspaceName(name);
  const changed = next !== entry.name;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !workspaceNameAcceptable(name)) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const workspace = await api.renameWorkspace(entry.id, next);
      scope?.update(workspace);
      onChanged({ ...entry, name: workspace.name });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const editable = can.allowed && !entry.archivedAt;
  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-name-title">
      <h3 id="workspace-name-title">{t("workspaceManage.identity.title")}</h3>
      {legacy ? <p className="muted small">{t("workspaceManage.identity.legacy")}</p> : null}
      {editable ? (
        <form className="stack" onSubmit={submit} aria-label={t("workspaceManage.identity.rename")}>
          <WorkspaceNameField
            value={name}
            onChange={(value) => {
              setName(value);
              setSaved(false);
            }}
            label={t("workspaceManage.identity.rename")}
          />
          {error ? (
            <p role="alert" className="error small">
              {error}
            </p>
          ) : null}
          {saved ? <output className="small">{t("workspaceManage.identity.saved")}</output> : null}
          <div className="form-actions">
            <Button
              type="submit"
              variant="default"
              disabled={busy || !changed || !workspaceNameAcceptable(name)}
            >
              {t("workspaceManage.identity.save")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="muted small">{t("workspaceManage.identity.renameDenied")}</p>
      )}
    </section>
  );
}
