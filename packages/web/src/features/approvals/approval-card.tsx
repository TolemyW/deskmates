import { ActionMenu } from "@deskmates/ui";
import { Button } from "../../components/ui/button.js";
import { DetailPane, DetailPaneContent } from "../../components/ui/detail-pane.js";
import { DialogDescription, DialogTitle } from "../../components/ui/dialog.js";
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
  type ApprovalRuleMatcher,
  type Attachment,
  type RunStatus,
  isApprovalAttachmentMime,
} from "@deskmates/contracts";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { ApiError } from "../../api/types.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { AlwaysScope } from "./always-scope.js";
import { ApprovalWait } from "./approval-wait.js";
import { IntegrationApprovalPreview } from "./integration-approval-preview.js";

export interface ApprovalCardProps {
  /** Request workspace; null means unresolved in the cross-workspace inbox. */
  workspaceId?: string | null;
  /** Compact presentation inside a conversation. */
  compact?: boolean;
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

function actionHost(approval: Approval): string | undefined {
  try {
    return new URL(approval.action.targetOrigin ?? "").hostname || undefined;
  } catch {
    return undefined;
  }
}

/** A deterministic, non-technical description; generated summaries may replace it, never facts. */
export function approvalActionSentence(approval: Approval): string {
  const { t } = currentI18n();
  if (approval.kind === "continuation") return t("approvalCard.action.continue");
  if (approval.kind === "egress")
    return t("approvalCard.action.openSite", { host: egressHost(approval) });
  const action = approval.action;
  const input = action.input as Record<string, unknown>;
  const tool = action.toolName.toLowerCase();
  const host = actionHost(approval);
  if (tool.endsWith("browser_click")) {
    const target =
      typeof input.element === "string"
        ? input.element
        : typeof input.text === "string"
          ? input.text
          : action.argumentSummary?.replace(/^click\s+/i, "");
    if (target)
      return host
        ? t("approvalCard.action.clickOn", { target, host })
        : t("approvalCard.action.click", { target });
  }
  if (tool.endsWith("browser_navigate")) {
    const destination = host ?? (typeof input.url === "string" ? input.url : action.targetOrigin);
    if (destination) return t("approvalCard.action.openSite", { host: destination });
  }
  if (tool === "bash" || tool.endsWith("shell") || tool.includes("tty")) {
    const command =
      typeof input.command === "string"
        ? input.command
        : (action.argumentSummary ?? action.toolName);
    return t("approvalCard.action.runCommand", { command });
  }
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path && /(write|edit|delete|move|rename)/.test(tool))
    return t("approvalCard.action.changeFile", { path });
  if (action.argumentSummary)
    return t("approvalCard.action.proposed", {
      action: action.argumentSummary,
      where: host ? t("approvalCard.action.where", { host }) : "",
    });
  return t("approvalCard.action.useTool", { tool: action.toolName });
}

export function approvalRiskSentence(approval: Approval): string {
  const { t } = currentI18n();
  if (approval.action.unclassified) return t("approvalCard.risk.unclassified");
  if (approval.kind === "continuation") return t("approvalCard.risk.continuation");
  if (approval.kind === "egress") return t("approvalCard.risk.newSite");
  return t("approvalCard.risk.externalChange");
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [denying, setDenying] = useState(false);
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askText, setAskText] = useState("");
  const [error, setError] = useState<string | undefined>();
  // Always and "allow this site" store configuration: an Admin's (ADR-0022 amendment 1, C1/C3).
  const persistentRole = useCan("approval.decidePersistent", props.workspaceId ?? undefined);
  const canPersist = props.workspaceId !== null && persistentRole.allowed;

  /** Deny the proposed action with new instructions; the queue stays in place for the next row. */
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

  const decide = async (
    decision: ApprovalDecision,
    why?: string,
    matcher?: ApprovalRuleMatcher,
  ) => {
    if (!approval || busy || (decision === "allow_always" && !canPersist)) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.decideApproval(approval.id, decision, why, matcher);
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
  const actionSentence = approval.displaySummary?.text ?? approvalActionSentence(approval);
  const technicalDetails = (
    <>
      {props.compact && !decided ? (
        <>
          {!egress && !continuation && !action.unclassified ? (
            <p className="approval-risk small">{approvalRiskSentence(approval)}</p>
          ) : null}
          <ApprovalWait approval={approval} runStatus={props.runStatus} api={api} />
        </>
      ) : null}
      <dl className="approval-facts small">
        <dt>{t("approvalCard.fact.tool")}</dt>
        <dd>
          <code>{action.toolName}</code>
        </dd>
        <dt>{t("approvalCard.fact.risk")}</dt>
        <dd>
          <code>{approval.riskLevel}</code>
        </dd>
        {action.targetOrigin ? (
          <>
            <dt>{t("approvalCard.fact.origin")}</dt>
            <dd>{action.targetOrigin}</dd>
          </>
        ) : null}
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
    </>
  );
  return (
    <div
      className={`approval-card ${props.compact ? "approval-inline" : ""} ${decided ? "decided" : "pending"}`}
      data-testid="approval-card"
      data-approval={approval.id}
    >
      <div className="approval-head">
        <div className="approval-target">
          <strong>
            {decided
              ? action.toolName
              : `${props.compact && props.botName ? `${props.botName} · ` : ""}${t("approvalCard.needsApproval")}`}
          </strong>
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
      </div>
      {approval.displaySummary ? (
        <p className="approval-summary-source small muted">{t("approvalCard.aiSummary")}</p>
      ) : null}
      <p className="approval-summary">{actionSentence}</p>
      {!decided && (!props.compact || egress || continuation || action.unclassified) ? (
        <p className="approval-risk small">{approvalRiskSentence(approval)}</p>
      ) : null}
      {!props.compact ? (
        <ApprovalWait approval={approval} runStatus={props.runStatus} api={api} />
      ) : null}
      {props.compact && !decided ? (
        <>
          <Button
            ref={detailsButton}
            type="button"
            variant="ghost"
            className="approval-details-trigger"
            aria-expanded={detailsOpen}
            data-chat-disclosure
            onClick={() => setDetailsOpen(true)}
          >
            {t("approvalCard.originalDetails")}
          </Button>
          <DetailPane open={detailsOpen} onOpenChange={setDetailsOpen}>
            <DetailPaneContent
              placement="right"
              className="detail-drawer approval-detail-drawer"
              closeLabel={t("approvalCard.closeDetails")}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                detailsButton.current?.focus();
              }}
            >
              <DialogTitle>{t("approvalCard.originalDetails")}</DialogTitle>
              <DialogDescription>{actionSentence}</DialogDescription>
              {technicalDetails}
            </DetailPaneContent>
          </DetailPane>
        </>
      ) : (
        <details className="approval-source">
          <summary>{t("approvalCard.originalDetails")}</summary>
          {technicalDetails}
        </details>
      )}
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
        // ADR-0002 amendment 3, A6: the stable-target scope, editable before it is stored.
        <AlwaysScope
          approval={approval}
          busy={busy}
          onConfirm={(matcher) => void decide("allow_always", undefined, matcher)}
          onCancel={() => setConfirmingAlways(false)}
        />
      ) : asking ? (
        <div className="approval-actions approval-form-actions approval-ask">
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
        <div className="approval-actions approval-form-actions">
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
        <div className="approval-actions approval-decisions">
          <div className="approval-decision-buttons">
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
            {props.compact ? (
              <ActionMenu
                label={t("approvalCard.moreActions")}
                disabled={busy}
                items={[
                  {
                    id: "redirect",
                    label: t("approvalCard.redirect"),
                    onAction: () => {
                      setAskText(
                        askMoreMessage(props.botName ?? approval.botId, egressHost(approval)),
                      );
                      setAsking(true);
                    },
                  },
                ]}
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="approval-redirect"
                disabled={busy}
                title={t("approvalCard.redirect.siteTitle")}
                onClick={() => {
                  setAskText(askMoreMessage(props.botName ?? approval.botId, egressHost(approval)));
                  setAsking(true);
                }}
              >
                {t("approvalCard.redirect")}
              </Button>
            )}
          </div>
          <RoleNote
            action="approval.decidePersistent"
            allowed={canPersist}
            does={t("approvalCard.roleNote.allowSite")}
          />
        </div>
      ) : (
        <div className="approval-actions approval-decisions">
          <div className="approval-decision-buttons">
            <Button
              type="button"
              variant="default"
              disabled={busy}
              onClick={() => void decide("allow_once")}
            >
              {continuation ? t("approvalCard.continue") : t("approvalCard.allowOnce")}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setDenying(true)}>
              {continuation ? t("approvalCard.stop") : t("approvalCard.deny")}
            </Button>
            {!continuation ? (
              props.compact ? (
                <ActionMenu
                  label={t("approvalCard.moreActions")}
                  disabled={busy}
                  items={[
                    ...(canPersist
                      ? [
                          {
                            id: "always",
                            label: t("approvalCard.always"),
                            onAction: () => setConfirmingAlways(true),
                          },
                        ]
                      : []),
                    {
                      id: "redirect",
                      label: t("approvalCard.redirect"),
                      onAction: () => {
                        setAskText(
                          askMoreMessage(props.botName ?? approval.botId, action.toolName),
                        );
                        setAsking(true);
                      },
                    },
                  ]}
                />
              ) : canPersist ? (
                <Button type="button" disabled={busy} onClick={() => setConfirmingAlways(true)}>
                  {t("approvalCard.always")}
                </Button>
              ) : null
            ) : null}
          </div>
          {!continuation && !props.compact ? (
            <Button
              type="button"
              variant="ghost"
              className="approval-redirect"
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
            <RoleNote
              action="approval.decidePersistent"
              allowed={canPersist}
              does={t("approvalCard.roleNote.always")}
            />
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
