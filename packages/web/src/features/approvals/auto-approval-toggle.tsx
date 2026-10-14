// The workspace automatic-approval switch (ADR-0002 amendment 4, B1), shown beside the network
// policy. Off by default; an Owner or Admin turns it on, everyone else sees its state. While it is
// on, an independent reviewer answers routine requests a human explicitly asked for; deletions,
// permission changes, new sites and browser actions still wait for a person.

import type { WorkspaceAutoApproval } from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

export function AutoApprovalToggle({ api, workspaceId }: { api: ApiClient; workspaceId: string }) {
  const t = useT();
  const canConfigure = useCan("workspace.configure").allowed;
  const [setting, setSetting] = useState<WorkspaceAutoApproval | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSetting(undefined);
    api
      .getAutoApproval(workspaceId)
      .then((value) => {
        if (!cancelled) setSetting(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      setSetting(await api.setAutoApproval(workspaceId, enabled));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="auto-approval" aria-labelledby={`auto-approval-${workspaceId}`}>
      <h4 id={`auto-approval-${workspaceId}`}>{t("approvals.auto.title")}</h4>
      <p className="muted small">{t("approvals.auto.body")}</p>
      <label className="auto-approval-switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={setting?.enabled ?? false}
          checked={setting?.enabled ?? false}
          disabled={busy || setting === undefined || !canConfigure}
          onChange={(event) => void change(event.currentTarget.checked)}
        />{" "}
        {setting?.enabled ? t("approvals.auto.on") : t("approvals.auto.off")}
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <RoleNote action="workspace.configure" does={t("approvals.auto.roleNote")} />
    </section>
  );
}
