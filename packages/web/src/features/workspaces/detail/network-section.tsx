// Detail › Network policy (ADR-0020, ADR-0034 decision 9): whether the workspace browses the open
// public internet or only an allowlist, edited in place. It reads the workspace and saves through
// `PATCH /api/workspaces/:id` (`workspace.configure`, Admin or Owner); removing a hostname asks
// first. Everyone else reads the mode and the list. The selected workspace never changes.

import {
  EGRESS_OPEN_INTERNET,
  type Workspace,
  isOpenInternetAllowlist,
} from "@deskmates/contracts";
import { Globe, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { errorMessage, splitList } from "../../../format.js";
import { useT } from "../../../i18n/i18n-provider.js";
import { useCan } from "../../../state/session-roles.js";
import { useOptionalWorkspaceScope } from "../../../state/workspace-scope.js";
import type { DetailSectionProps } from "../detail-sections.js";
import { EgressModePicker } from "../egress-mode-picker.js";

/** Hostnames typed one per line or separated by commas; the open-internet entry is the mode. */
function hostnames(text: string): string[] {
  return [...new Set(splitList(text))].filter((host) => host !== EGRESS_OPEN_INTERNET);
}

export function NetworkSection({ api, entry, onChanged }: DetailSectionProps) {
  const t = useT();
  const scope = useOptionalWorkspaceScope();
  const can = useCan("workspace.configure", entry.id);
  const editable = can.allowed && !entry.archivedAt;
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loadError, setLoadError] = useState<string>();
  const [loadRevision, setLoadRevision] = useState(0);
  const [locked, setLocked] = useState(!entry.openInternet);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const reset = (next: Workspace) => {
    const open = isOpenInternetAllowlist(next.egressAllowlist);
    setWorkspace(next);
    setLocked(!open);
    setDraft(open ? "" : next.egressAllowlist.join("\n"));
    setConfirming(false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for another workspace or an explicit retry
  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    setWorkspace(undefined);
    api
      .getWorkspace(entry.id)
      .then((view) => {
        if (!cancelled) reset(view.workspace);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, entry.id, loadRevision]);

  const next = useMemo(() => (locked ? hostnames(draft) : [EGRESS_OPEN_INTERNET]), [draft, locked]);
  const current = workspace?.egressAllowlist ?? [];
  const removed = current.filter((host) => !next.includes(host));
  const changed = next.length !== current.length || removed.length > 0;
  const open = workspace ? isOpenInternetAllowlist(workspace.egressAllowlist) : entry.openInternet;

  const save = async () => {
    if (!workspace || !changed) return;
    if (removed.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const stored = await api.updateWorkspaceEgress(workspace.id, next);
      reset(stored);
      scope?.update(stored);
      onChanged({ ...entry, openInternet: isOpenInternetAllowlist(stored.egressAllowlist) });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card workspace-detail-section" aria-labelledby="workspace-network-title">
      <h3 id="workspace-network-title">{t("workspaceManage.network.title")}</h3>
      <p className="network-mode-line">
        {open ? (
          <>
            <Globe size={14} aria-hidden="true" /> {t("workspaceManage.network.open")}
          </>
        ) : (
          <>
            <Lock size={14} aria-hidden="true" /> {t("workspaceManage.network.locked")}
          </>
        )}
      </p>
      {loadError ? (
        <div role="alert" className="error small">
          {t("workspaceManage.network.loadFailed", { error: loadError })}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => setLoadRevision((value) => value + 1)}
          >
            {t("workspaceManage.retry")}
          </Button>
        </div>
      ) : workspace === undefined ? (
        <output className="muted small">{t("workspaceManage.network.loading")}</output>
      ) : editable ? (
        <form
          className="stack"
          aria-label={t("workspaceManage.network.edit")}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <EgressModePicker
            locked={locked}
            domains={draft}
            disabled={busy}
            onLocked={(value) => {
              setLocked(value);
              setConfirming(false);
              setSaved(false);
            }}
            onDomains={(value) => {
              setDraft(value);
              setConfirming(false);
              setSaved(false);
            }}
          />
          {error ? (
            <p role="alert" className="error small">
              {error}
            </p>
          ) : null}
          {saved ? <output className="small">{t("workspaceManage.network.saved")}</output> : null}
          {confirming ? (
            <div className="management-confirm" role="alert">
              <p>{t("workspaceManage.network.confirmRemoval", { hosts: removed.join(", ") })}</p>
              <div className="form-actions">
                <Button type="submit" variant="destructive" disabled={busy}>
                  {t("workspaceManage.network.confirmRemovalButton")}
                </Button>
                <Button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  {t("workspaceManage.network.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="form-actions">
              <Button type="submit" variant="default" disabled={busy || !changed}>
                {t("workspaceManage.network.save")}
              </Button>
            </div>
          )}
        </form>
      ) : (
        <>
          {open ? null : current.length === 0 ? (
            <p className="muted small">{t("workspaceManage.network.empty")}</p>
          ) : (
            <ul className="workspace-allowlist" aria-label={t("workspaceManage.network.list")}>
              {current.map((host) => (
                <li key={host}>
                  <code>{host}</code>
                </li>
              ))}
            </ul>
          )}
          {entry.archivedAt ? null : (
            <p className="muted small">{t("workspaceManage.network.denied")}</p>
          )}
        </>
      )}
    </section>
  );
}
