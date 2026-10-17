// The workspace approval mode (ADR-0002 amendment 6, D1), the body of the workspace detail page's
// Approvals section (ADR-0034 decision 4): who answers a request that needs approval, a person,
// an independent AI reviewer first (the default for a new workspace), or nobody because the
// workspace approves all. An Owner or Admin of that workspace changes it; everyone else sees it.
// The request expiry of amendment 3 A7 sits beside it. `ApproveAllBadge` is the marker the chat and
// workspace headers show while a workspace approves all.

import {
  APPROVAL_EXPIRY_MAX_MINUTES,
  APPROVAL_EXPIRY_MIN_MINUTES,
  APPROVAL_MODES,
  type ApprovalMode,
  type WorkspaceAutoApproval,
} from "@deskmates/contracts";
import { ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

const MODE_LABEL: Record<ApprovalMode, MessageKey> = {
  manual: "approvals.mode.manual",
  automatic: "approvals.mode.automatic",
  approve_all: "approvals.mode.approveAll",
};

const MODE_HINT: Record<ApprovalMode, MessageKey> = {
  manual: "approvals.mode.manual.hint",
  automatic: "approvals.mode.automatic.hint",
  approve_all: "approvals.mode.approveAll.hint",
};

type ApprovalSettingsApi = Pick<
  ApiClient,
  "getAutoApproval" | "setApprovalMode" | "setApprovalExpiry"
>;

/** The workspace's approval setting, read once per workspace. */
function useApprovalSetting(
  api: Pick<ApiClient, "getAutoApproval">,
  workspaceId: string | undefined,
) {
  const [setting, setSetting] = useState<WorkspaceAutoApproval | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSetting(undefined);
    if (!workspaceId) return;
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
  return { setting, setSetting, error, setError };
}

export function ApprovalModeSetting({
  api,
  workspaceId,
  readOnly = false,
}: {
  api: ApprovalSettingsApi;
  workspaceId: string;
  /** An archived workspace shows its setting without the choice working. */
  readOnly?: boolean;
}) {
  const t = useT();
  const canConfigure = useCan("workspace.configure", workspaceId).allowed;
  const { setting, setSetting, error, setError } = useApprovalSetting(api, workspaceId);
  const [busy, setBusy] = useState(false);

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
  const disabled = busy || setting === undefined || !canConfigure || readOnly;

  return (
    <div className="approval-mode">
      <fieldset className="approval-mode-choices" disabled={disabled}>
        <legend className="muted small">{t("approvals.mode.legend")}</legend>
        {APPROVAL_MODES.map((mode) => (
          <label key={mode} className={`approval-mode-choice approval-mode-${mode}`}>
            <input
              type="radio"
              name={`approval-mode-${workspaceId}`}
              value={mode}
              checked={setting?.mode === mode}
              disabled={disabled}
              onChange={() => {
                if (setting?.mode !== mode) void save(() => api.setApprovalMode(workspaceId, mode));
              }}
            />{" "}
            <span className="approval-mode-label">{t(MODE_LABEL[mode])}</span>
            <span className="muted small approval-mode-hint">{t(MODE_HINT[mode])}</span>
          </label>
        ))}
      </fieldset>
      {setting?.mode === "approve_all" ? <ApproveAllMarker /> : null}
      <ApprovalExpiryField
        value={setting?.expiryMinutes}
        disabled={disabled}
        onSave={(minutes) => void save(() => api.setApprovalExpiry(workspaceId, minutes))}
      />
      {error ? (
        <p role="alert" className="error small">
          {error}
        </p>
      ) : null}
      <RoleNote
        action="workspace.configure"
        does={t("approvals.mode.roleNote")}
        allowed={canConfigure}
      />
    </div>
  );
}

function ApproveAllMarker() {
  const t = useT();
  return (
    <span
      className="approve-all-badge"
      data-testid="approve-all-badge"
      title={t("approvals.mode.badge.title")}
    >
      <ShieldOff size={14} aria-hidden="true" /> {t("approvals.mode.badge")}
    </span>
  );
}

/**
 * Amendment 6, D1: the marker a chat or workspace header shows while its workspace approves all.
 * Renders nothing in the other modes, while loading, or when the setting cannot be read.
 */
export function ApproveAllBadge({
  api,
  workspaceId,
}: {
  api: Pick<ApiClient, "getAutoApproval">;
  workspaceId?: string | undefined;
}) {
  const { setting } = useApprovalSetting(api, workspaceId);
  return setting?.mode === "approve_all" ? <ApproveAllMarker /> : null;
}

/**
 * ADR-0002 amendment 3, A7: how long an undecided request waits before it expires to deny; one
 * reminder reaches people when a third is left (A8). Whole minutes from 1 to 1440, 60 by default.
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
