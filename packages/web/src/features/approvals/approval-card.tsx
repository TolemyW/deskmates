import { Button } from "../../components/ui/button.js";
import { useActorLabel } from "../../state/session-roles.js";
// One approval, drawn wherever it appears: inline in a transcript (joined to the `system` message
// that carries the approval attachment) and as a row in the inbox. ADR-0002 amendment 2: an
// approval is decided once, by any member of the thread, and the decision is a thread message.
//
// The card never invents the action. It reads it from the `Approval` the Gateway returns; until
// that has loaded it shows the three-line message body the Gateway wrote, so a transcript opened
// before the approval fetch lands is still readable.

import {
  type Approval,
  type ApprovalDecision,
  type Attachment,
  type RunStatus,
  isApprovalAttachmentMime,
  matcherFromAction,
} from "@deskmates/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { ApprovalWait } from "./approval-wait.js";
import { IntegrationApprovalPreview } from "./integration-approval-preview.js";

export interface ApprovalCardProps {
  approval: Approval | undefined;
  /** The `system` message body, shown verbatim while `approval` is undefined. */
  fallbackBody?: string;
  /** Called with the Gateway's answer so the caller can put it in its own state. */
  onDecided?: (approval: Approval) => void;
  api?: ApiClient;
  /** Extra facts the inbox shows and the transcript does not (bot, thread link, age). */
  children?: ReactNode;
  /** The asking bot's name, for "Ask the bot": the question is posted to its chat as a mention. */
  botName?: string | undefined;
  /**
   * Set where this page must not decide (a channel thread's read-only mirror, ADR-0017 amendment
   * 2): a pending request shows this note instead of its buttons.
   */
  readOnlyNote?: string | undefined;
  /**
   * The asking run's status, where the screen has it (the chat), so the card can tell a live wait
   * from a parked one (issue #9); without it the approval's wait mode and short wait decide.
   */
  runStatus?: RunStatus | undefined;
}

/** The suggested text when the operator wants the bot to think again before acting. */
export function askMoreMessage(botName: string, toolName: string): string {
  return currentI18n().t("approvalCard.askMore", { bot: botName, target: toolName });
}

const DECISION_LABEL: Record<ApprovalDecision, MessageKey> = {
  allow_once: "approvalCard.decision.allowOnce",
  allow_always: "approvalCard.decision.allowAlways",
  deny: "approvalCard.decision.deny",
};

/** The host an egress approval asks to open, from the action's origin. */
export function egressHost(approval: Approval): string {
  try {
    return (
      new URL(approval.action.targetOrigin ?? "").hostname ||
      currentI18n().t("approvalCard.thisSite")
    );
  } catch {
    return currentI18n().t("approvalCard.thisSite");
  }
}

export function decisionLabel(
  approval: Approval,
  label: (actor: string) => string = (actor) => actor,
): string {
  const { t } = currentI18n();
  const by = (verb: string): string =>
    approval.decidedBy
      ? t("approvalCard.decision.by", { verb, who: label(approval.decidedBy) })
      : verb;
  // ADR-0002 amendment 3, A7: nobody denied an expired request, so no "by" either.
  if (approval.decidedBy === "system:expiry" && approval.kind !== "continuation")
    return t("approvalCard.decision.expired");
  if (approval.kind === "egress") {
    return by(
      approval.decision === "allow_always"
        ? t("approvalCard.decision.siteAllowed", { host: egressHost(approval) })
        : approval.decision === "deny"
          ? t("approvalCard.decision.siteDenied")
          : t("approvalCard.decision.pending"),
    );
  }
  if (approval.kind === "continuation") {
    return by(
      approval.decision === "allow_once"
        ? t("approvalCard.decision.continued")
        : approval.decision === "deny"
          ? t("approvalCard.decision.stopped")
          : t("approvalCard.decision.pending"),
    );
  }
  return by(
    approval.decision ? t(DECISION_LABEL[approval.decision]) : t("approvalCard.decision.pending"),
  );
}

export function ApprovalCard(props: ApprovalCardProps) {
  const { approval, fallbackBody } = props;
  const actorName = useActorLabel();
  const api = props.api ?? defaultApi;
  const t = useT();
  const [denying, setDenying] = useState(false);
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askText, setAskText] = useState("");
  const [error, setError] = useState<string | undefined>();
  // Always and "allow this site" store configuration: an Admin's (ADR-0022 amendment 1, C1/C3).
  const canPersist = useCan("approval.decidePersistent").allowed;

  /**
   * Like telling a coding agent what to do instead of the tool call it proposed: the pending
   * action is denied with the operator's words as the reason, the run resumes and reads them,
   * and the chat opens so the bot's next step is in view.
   */
  const redirect = async () => {
    if (!approval || busy) return;
    const text = askText.trim();
    if (!text) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.decideApproval(approval.id, "deny", text);
      props.onDecided?.(result.approval);
      setAsking(false);
      if (approval.threadId) {
        const target = `#/threads/${encodeURIComponent(approval.threadId)}`;
        if (window.location.hash !== target) window.location.hash = target;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          props.onDecided?.(await api.getApproval(approval.id));
        } catch (refreshError) {
          setError(errorMessage(refreshError));
        }
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: ApprovalDecision, why?: string) => {
    if (!approval || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.decideApproval(approval.id, decision, why);
      props.onDecided?.(result.approval);
    } catch (err) {
      // Another operator or a bot may have decided after this card rendered. The conflict is a
      // prompt to fetch the authority, not an error that should leave stale decision buttons.
      if (err instanceof ApiError && err.status === 409) {
        try {
          props.onDecided?.(await api.getApproval(approval.id));
        } catch (refreshError) {
          setError(errorMessage(refreshError));
        }
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!approval) {
    return (
      <div className="approval-card pending" data-testid="approval-card">
        <div className="body">{t("approvalCard.fallback")}</div>
        {fallbackBody ? (
          <details className="approval-source">
            <summary>{t("approvalCard.originalDetails")}</summary>
            <div className="body">{fallbackBody}</div>
          </details>
        ) : null}
      </div>
    );
  }

  const decided = approval.decision !== undefined;
  const continuation = approval.kind === "continuation";
  const egress = approval.kind === "egress";
  const { action } = approval;
  const alwaysScope = matcherFromAction(action);
  return (
    <div
      className={`approval-card ${decided ? "decided" : "pending"}`}
      data-testid="approval-card"
      data-approval={approval.id}
    >
      <div className="approval-head">
        <span className="kind approval">
          {continuation
            ? t("approvalCard.kind.continuation")
            : egress
              ? t("approvalCard.kind.newSite")
              : approval.riskLevel}
        </span>
        <strong>
          {continuation
            ? t("approvalCard.turnLimit")
            : egress
              ? t("approvalCard.openHost", { host: egressHost(approval) })
              : action.toolName}
        </strong>
        {!egress && action.targetOrigin ? (
          <span className="muted">{action.targetOrigin}</span>
        ) : null}
        {/* ADR-0002 amendment 3, A5: an untiered tool and the subagent that asked, shown as such. */}
        {action.unclassified ? (
          <span className="kind" title={t("approvalCard.unclassifiedWhy")}>
            {t("approvalCard.unclassified")}
          </span>
        ) : null}
        {action.agentType ? (
          <span className="muted">{t("approvalCard.subagent", { type: action.agentType })}</span>
        ) : null}
      </div>
      {approval.displaySummary?.text ? (
        <div className="approval-summary">
          <span className="approval-summary-label">{t("approvalCard.aiSummary")}</span>
          <p>{approval.displaySummary.text}</p>
        </div>
      ) : (
        <p className="muted small approval-summary">
          {egress
            ? t("approvalCard.egressWhy", { host: egressHost(approval) })
            : action.argumentSummary && action.argumentSummary.length <= 160
              ? `${t("approvalCard.fact.arguments")}: ${action.argumentSummary}`
              : t("approvalCard.summaryUnavailable")}
        </p>
      )}
      <ApprovalWait approval={approval} runStatus={props.runStatus} api={api} />
      <details className="approval-source">
        <summary>{t("approvalCard.originalDetails")}</summary>
        <dl className="approval-facts small">
          {egress ? (
            <>
              <dt>{t("approvalCard.fact.why")}</dt>
              <dd>{t("approvalCard.egressWhy", { host: egressHost(approval) })}</dd>
              <dt>{t("approvalCard.fact.page")}</dt>
              <dd>{action.argumentSummary ?? action.targetOrigin ?? t("approvalCard.none")}</dd>
            </>
          ) : (
            <>
              <dt>{t("approvalCard.fact.arguments")}</dt>
              <dd>{action.argumentSummary ?? t("approvalCard.none")}</dd>
            </>
          )}
          <dt>{t("approvalCard.fact.instruction")}</dt>
          <dd>{approval.instruction ?? t("approvalCard.none")}</dd>
        </dl>
        {action.toolName === "mcp__deskmates__integration_execute" ? (
          <IntegrationApprovalPreview input={action.input} />
        ) : null}
        <pre className="approval-input">{JSON.stringify(action.input, null, 2)}</pre>
        {approval.decidedBy ? (
          <p className="muted small">
            {t("actor.audit")}: <code>{approval.decidedBy}</code>
          </p>
        ) : null}
        {approval.reason ? <p className="muted">{approval.reason}</p> : null}
      </details>
      {props.children}
      {decided ? (
        <p className="approval-decision" data-testid="approval-decision">
          {decisionLabel(approval, actorName)}
        </p>
      ) : props.readOnlyNote !== undefined ? (
        <p className="muted small" data-testid="approval-read-only">
          {props.readOnlyNote}
        </p>
      ) : confirmingAlways ? (
        <div className="approval-actions">
          <p className="small">{t("approvalCard.always.intro")}</p>
          <dl className="small">
            <dt>{t("approvalCard.always.tool")}</dt>
            <dd>{alwaysScope.toolName}</dd>
            <dt>{t("approvalCard.always.origin")}</dt>
            <dd>{alwaysScope.targetOrigin ?? t("approvalCard.always.anyOrigin")}</dd>
            <dt>{t("approvalCard.always.arguments")}</dt>
            <dd>{alwaysScope.argumentPattern ?? t("approvalCard.always.anyArguments")}</dd>
          </dl>
          <Button
            type="button"
            variant="default"
            disabled={busy}
            onClick={() => void decide("allow_always")}
          >
            {t("approvalCard.always.confirm")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setConfirmingAlways(false)}>
            {t("approvalCard.cancel")}
          </Button>
        </div>
      ) : asking ? (
        <div className="approval-actions approval-ask">
          <label className="small approval-ask-label">
            {t("approvalCard.ask.label", { bot: props.botName ?? t("approvalCard.ask.theBot") })}
            <textarea
              aria-label={t("approvalCard.ask.textarea")}
              value={askText}
              rows={3}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void redirect();
                }
              }}
            />
          </label>
          <Button
            type="button"
            variant="default"
            disabled={busy || !askText.trim()}
            onClick={() => void redirect()}
          >
            {t("approvalCard.ask.send")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setAsking(false)}>
            {t("approvalCard.cancel")}
          </Button>
        </div>
      ) : denying ? (
        <div className="approval-actions">
          <label className="small">
            {t("approvalCard.deny.reason")}
            <input
              aria-label={t("approvalCard.deny.reason")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("approvalCard.deny.optional")}
            />
          </label>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void decide("deny", reason.trim() || undefined)}
          >
            {continuation ? t("approvalCard.deny.confirmStop") : t("approvalCard.deny.confirmDeny")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setDenying(false)}>
            {t("approvalCard.cancel")}
          </Button>
        </div>
      ) : egress ? (
        <div className="approval-actions">
          {canPersist ? (
            <Button
              type="button"
              variant="default"
              disabled={busy}
              onClick={() => void decide("allow_always")}
            >
              {t("approvalCard.allowSite")}
            </Button>
          ) : null}
          <Button type="button" disabled={busy} onClick={() => setDenying(true)}>
            {t("approvalCard.deny")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            title={t("approvalCard.redirect.siteTitle")}
            onClick={() => {
              setAskText(askMoreMessage(props.botName ?? approval.botId, egressHost(approval)));
              setAsking(true);
            }}
          >
            {t("approvalCard.redirect")}
          </Button>
          <RoleNote
            action="approval.decidePersistent"
            does={t("approvalCard.roleNote.allowSite")}
          />
        </div>
      ) : (
        <div className="approval-actions">
          <Button
            type="button"
            variant="default"
            disabled={busy}
            onClick={() => void decide("allow_once")}
          >
            {continuation ? t("approvalCard.continue") : t("approvalCard.allowOnce")}
          </Button>
          {!continuation && canPersist ? (
            <Button type="button" disabled={busy} onClick={() => setConfirmingAlways(true)}>
              {t("approvalCard.always")}
            </Button>
          ) : null}
          <Button type="button" disabled={busy} onClick={() => setDenying(true)}>
            {continuation ? t("approvalCard.stop") : t("approvalCard.deny")}
          </Button>
          {!continuation ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              title={t("approvalCard.redirect.actionTitle")}
              onClick={() => {
                setAskText(askMoreMessage(props.botName ?? approval.botId, action.toolName));
                setAsking(true);
              }}
            >
              {t("approvalCard.redirect")}
            </Button>
          ) : null}
          {!continuation ? (
            <RoleNote action="approval.decidePersistent" does={t("approvalCard.roleNote.always")} />
          ) : null}
        </div>
      )}
      {error ? <p className="error small">{error}</p> : null}
    </div>
  );
}

/** The attachment that links a `system` thread message to its approval, if it carries one. */
export function approvalRefOf(attachments: readonly Attachment[]): string | undefined {
  return attachments.find((a) => isApprovalAttachmentMime(a.mimeType))?.ref;
}
