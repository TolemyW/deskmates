// The workspace automatic-approval switch (ADR-0002 amendment 4, B1), the body of the workspace
// detail page's Automatic approval section (ADR-0034 decision 4). Off by default; an Owner or Admin
// of that workspace turns it on, everyone else sees its state. While it is on, an independent
// reviewer answers routine requests a human explicitly asked for; deletions, permission changes,
// new sites and browser actions still wait for a person. Further approval settings of the
// workspace belong beside the switch, in this component.

import {
  APPROVAL_EXPIRY_MAX_MINUTES,
  APPROVAL_EXPIRY_MIN_MINUTES,
  type WorkspaceAutoApproval,
} from "@deskmates/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

export function AutoApprovalToggle({
  api,
  workspaceId,
  readOnly = false,
}: {
  api: ApiClient;
  workspaceId: string;
  /** An archived workspace shows its setting without the switch working. */
  readOnly?: boolean;
}) {
  const t = useT();
  const canConfigure = useCan("workspace.configure", workspaceId).allowed;
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

  const save = async (write: () => Promise<WorkspaceAutoApproval>) => {
    setBusy(true);
    setError("");
    try {
      setSetting(await write());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const change = (enabled: boolean) => save(() => api.setAutoApproval(workspaceId, enabled));

  return (
    <div className="auto-approval">
      <p className="muted small">{t("approvals.auto.body")}</p>
      <label className="auto-approval-switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={setting?.enabled ?? false}
          checked={setting?.enabled ?? false}
          disabled={busy || setting === undefined || !canConfigure || readOnly}
          onChange={(event) => void change(event.currentTarget.checked)}
        />{" "}
        {setting?.enabled ? t("approvals.auto.on") : t("approvals.auto.off")}
      </label>
      <ApprovalExpiryField
        value={setting?.expiryMinutes}
        disabled={busy || setting === undefined || !canConfigure || readOnly}
        onSave={(minutes) => void save(() => api.setApprovalExpiry(workspaceId, minutes))}
      />
      {error ? (
        <p role="alert" className="error small">
          {error}
        </p>
      ) : null}
      <RoleNote
        action="workspace.configure"
        does={t("approvals.auto.roleNote")}
        allowed={canConfigure}
      />
    </div>
  );
}

/**
 * ADR-0002 amendment 3, A7: how long an undecided request waits before it expires to deny; one
 * reminder reaches people before that (A8). Whole minutes from 1 to 1440.
 */
function ApprovalExpiryField({
  value,
  disabled,
  onSave,
}: {
  value: number | undefined;
  disabled: boolean;
  onSave: (minutes: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  const minutes = Number(draft);
  const valid =
    Number.isInteger(minutes) &&
    minutes >= APPROVAL_EXPIRY_MIN_MINUTES &&
    minutes <= APPROVAL_EXPIRY_MAX_MINUTES;
  return (
    <form
      className="auto-approval-expiry"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && minutes !== value) onSave(minutes);
      }}
    >
      <label>
        {t("approvals.expiry.label")}{" "}
        <input
          type="number"
          min={APPROVAL_EXPIRY_MIN_MINUTES}
          max={APPROVAL_EXPIRY_MAX_MINUTES}
          step={1}
          value={draft}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />{" "}
        {t("approvals.expiry.unit")}
      </label>{" "}
      <button type="submit" disabled={disabled || !valid || minutes === value}>
        {t("approvals.expiry.save")}
      </button>
      <p className="muted small">{t("approvals.expiry.hint")}</p>
    </form>
  );
}
