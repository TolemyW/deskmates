// The Always confirmation (ADR-0002 amendment 3, A6): the rule the Gateway would store, the tool
// plus a stable target derived from the action, shown as editable fields. The human may widen or
// narrow it before saving; the same checks the Gateway runs (`checkAlwaysRule`) say beforehand
// whether it would be refused or matches only this action again. An unedited scope is sent as
// nothing, so the Gateway stores its own proposal.

import {
  type Approval,
  type ApprovalRuleMatcher,
  checkAlwaysRule,
  matcherFromAction,
} from "@deskmates/contracts";
import { useState } from "react";
import { Button } from "../../components/ui/button.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";

export interface AlwaysScopeProps {
  approval: Approval;
  busy: boolean;
  /** `matcher` is undefined when the human kept the proposal unchanged. */
  onConfirm: (matcher: ApprovalRuleMatcher | undefined) => void;
  onCancel: () => void;
}

type TextField = "targetOrigin" | "argumentPattern" | "filePath";

const WARNING: Record<string, MessageKey> = {
  exact_arguments: "approvalCard.always.warning.exactArguments",
  exact_input: "approvalCard.always.warning.exactInput",
};

const REFUSAL: Record<string, MessageKey> = {
  rule_pattern_truncated: "approvalCard.always.refusal.truncated",
  rule_does_not_match_action: "approvalCard.always.refusal.mismatch",
  rule_vault_not_exact: "approvalCard.always.refusal.vaultExact",
};

/** The matcher without one field: an absent field matches anything. */
function without(m: ApprovalRuleMatcher, key: keyof ApprovalRuleMatcher): ApprovalRuleMatcher {
  return Object.fromEntries(Object.entries(m).filter(([k]) => k !== key)) as ApprovalRuleMatcher;
}

function sameMatcher(a: ApprovalRuleMatcher, b: ApprovalRuleMatcher): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ApprovalRuleMatcher>;
  return [...keys].every((k) => a[k] === b[k]);
}

export function AlwaysScope({ approval, busy, onConfirm, onCancel }: AlwaysScopeProps) {
  const t = useT();
  const { action } = approval;
  const proposal = matcherFromAction(action);
  const [draft, setDraft] = useState<ApprovalRuleMatcher>(
    proposal ?? { toolName: action.toolName },
  );
  const check = checkAlwaysRule(draft, { action, botId: approval.botId });
  const edited = proposal === undefined || !sameMatcher(draft, proposal);

  const setField = (field: TextField, value: string) =>
    setDraft((current) => {
      if (value === "") return without(current, field);
      return { ...current, [field]: value };
    });
  const field = (name: TextField, label: MessageKey, any: MessageKey) => (
    <>
      <dt>{t(label)}</dt>
      <dd>
        <input
          aria-label={t(label)}
          value={draft[name] ?? ""}
          placeholder={t(any)}
          onChange={(e) => setField(name, e.target.value)}
        />
      </dd>
    </>
  );

  return (
    <div className="approval-actions approval-form-actions" data-testid="always-scope">
      <p className="small">{t("approvalCard.always.intro")}</p>
      {proposal === undefined ? (
        <p className="small muted">{t("approvalCard.always.noTarget")}</p>
      ) : null}
      <p className="small muted">{t("approvalCard.always.editHint")}</p>
      <dl className="small">
        <dt>{t("approvalCard.always.tool")}</dt>
        <dd>{draft.toolName}</dd>
        {field("targetOrigin", "approvalCard.always.origin", "approvalCard.always.anyOrigin")}
        {field(
          "argumentPattern",
          "approvalCard.always.arguments",
          "approvalCard.always.anyArguments",
        )}
        {action.filePath !== undefined || draft.filePath !== undefined
          ? field("filePath", "approvalCard.always.filePath", "approvalCard.always.anyPath")
          : null}
      </dl>
      {proposal?.inputSha256 !== undefined ? (
        <label className="small">
          <input
            type="checkbox"
            checked={draft.inputSha256 !== undefined}
            onChange={(e) =>
              setDraft((current) =>
                e.target.checked && proposal.inputSha256 !== undefined
                  ? { ...current, inputSha256: proposal.inputSha256 }
                  : without(current, "inputSha256"),
              )
            }
          />{" "}
          {t("approvalCard.always.exactInput")}
        </label>
      ) : null}
      {check.ok ? (
        check.warnings.map((w) => (
          <p key={w} className="small muted" data-testid="always-warning">
            {WARNING[w] ? t(WARNING[w]) : w}
          </p>
        ))
      ) : (
        <p className="small error" role="alert">
          {REFUSAL[check.refusal] ? t(REFUSAL[check.refusal] as MessageKey) : check.message}
        </p>
      )}
      <Button
        type="button"
        variant="default"
        disabled={busy || !check.ok}
        onClick={() => onConfirm(edited ? draft : undefined)}
      >
        {t("approvalCard.always.confirm")}
      </Button>
      <Button type="button" disabled={busy} onClick={onCancel}>
        {t("approvalCard.cancel")}
      </Button>
    </div>
  );
}
