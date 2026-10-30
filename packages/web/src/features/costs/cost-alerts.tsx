import { Input, Pill, Select } from "@deskmates/ui";
// Cost alerts on the Costs screen (ADR-0018 decision 6, issue #24). Two surfaces with two jobs:
// the Alerts card triages what already fired (scannable rows, details on request, acknowledge,
// ten per page from the Gateway, #113), and the Alert rules panel configures what fires next
// (summary, 25 rules a page, New rule on
// request, delete). An alert is a soft threshold; nothing here changes what a run may do, and an
// unpriced window is shown as unknown, never zero. The panel owns the subscription, so live
// `cost_alert` frames and reconnect recovery keep working while the rules panel is closed.

import type {
  BotDefinition,
  BotId,
  CostAlert,
  CostAlertKind,
  CostAlertRule,
  CostAlertWindow,
  CostTotals,
} from "@deskmates/contracts";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { PageBar } from "../../lib/page-bar.js";
import { type PagedQuery, usePagedQuery } from "../../lib/use-paged-query.js";
import { runHref } from "../../router.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

/** Open alerts: ten a page; alert rules: 25 a page; both from the Gateway (#113). */
export const ALERT_PAGE_SIZE = 10;
export const RULE_PAGE_SIZE = 25;

/** US dollars to two decimals, matching every other Costs surface. */
function dollars(value: number): string {
  return value.toLocaleString(currentI18n().locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function kindLabel(kind: CostAlertKind): string {
  const { t } = currentI18n();
  return kind === "unpriced_usage"
    ? t("costAlerts.kind.unpricedUsage")
    : t("costAlerts.kind.knownCost");
}

/** The spend an alert row leads with: known, known plus unpriced, or unknown. Never zero for unknown. */
function alertAmount(alert: CostAlert): string {
  const { t } = currentI18n();
  const { knownCostUsd, unpricedUsageCount } = alert.totals;
  if (knownCostUsd === null) return t("costAlerts.amount.unknown", { count: unpricedUsageCount });
  if (alert.kind === "unpriced_usage")
    return t("costAlerts.amount.unpriced", { count: unpricedUsageCount });
  if (unpricedUsageCount > 0)
    return t("costAlerts.amount.partial", {
      amount: dollars(knownCostUsd),
      count: unpricedUsageCount,
    });
  return dollars(knownCostUsd);
}

function threshold(item: Pick<CostAlertRule, "kind" | "thresholdUsd">): string {
  const { t } = currentI18n();
  return item.kind === "known_cost" && item.thresholdUsd !== undefined
    ? dollars(item.thresholdUsd)
    : t("costAlerts.rules.noThreshold");
}

/** `2026-10-02T10:00:00.000Z` → `2026-10-02 10:00 UTC`. */
function utcTime(iso: string): string {
  const { t } = currentI18n();
  const date = new Date(iso);
  const time = Number.isNaN(date.getTime())
    ? iso
    : date.toISOString().slice(0, 16).replace("T", " ");
  return t("costAlerts.details.utcTime", { time });
}

interface RuleDraft {
  open: boolean;
  kind: CostAlertKind;
  window: CostAlertWindow;
  botId: string;
  threshold: string;
}

const EMPTY_DRAFT: RuleDraft = {
  open: false,
  kind: "known_cost",
  window: "day",
  botId: "",
  threshold: "",
};

export function CostAlertsPanel({ api, bots }: { api: ApiClient; bots: BotDefinition[] }) {
  const t = useT();
  // Open alerts newest first, one keyset page at a time; the badge is the Gateway's count of
  // every open alert, never the page's length (#113).
  const alertPages = usePagedQuery<CostAlert>({
    scopeKey: "costs.alerts:open",
    limit: ALERT_PAGE_SIZE,
    mode: "cursor",
    historyKey: "costs.alerts",
    fetchPage: async ({ cursor, limit }) => {
      const page = await api.listCostAlerts("open", { ...(cursor ? { cursor } : {}), limit });
      return {
        items: page.alerts,
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  });
  const rulePages = usePagedQuery<CostAlertRule>({
    scopeKey: "costs.alertRules",
    limit: RULE_PAGE_SIZE,
    mode: "offset",
    fetchPage: async ({ offset, limit }) => {
      const page = await api.listCostAlertRules({ offset, limit });
      return { items: page.rules, total: page.total };
    },
  });
  // `undefined` means "not loaded yet": an empty list is only shown after a successful load.
  const alertTotal = alertPages.page?.total;
  const ruleTotal = rulePages.page?.total;
  // Load failures and mutation failures are kept apart, so a background refresh never clears
  // the error an operator action produced (a rejected rule stays beside its form).
  const alertsError = alertPages.error ? errorMessage(alertPages.error) : "";
  const rulesError = rulePages.error ? errorMessage(rulePages.error) : "";
  const [ackError, setAckError] = useState("");
  const [ruleActionError, setRuleActionError] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rulesOpen, setRulesOpen] = useState(false);
  // The draft lives here, not in the panel, so closing and reopening the panel keeps it.
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const mutationPending = useRef(false);
  const canCreate = useCan("costRule.create").allowed;
  const canDelete = useCan("costRule.delete").allowed;
  const listId = useId();

  const botName = (id: BotId | undefined): string =>
    id === undefined ? t("costAlerts.allBots") : (bots.find((b) => b.id === id)?.name ?? id);

  // Each list refetches its current page; a later request supersedes an earlier one.
  const reloadAlerts = alertPages.reload;
  const reloadRules = rulePages.reload;
  const reload = useCallback(() => {
    reloadAlerts();
    reloadRules();
  }, [reloadAlerts, reloadRules]);

  useEffect(() => {
    // A `cost_alert` frame means the open list changed under us: the current page is read again,
    // so a new alert never shifts a later page. Frames lost while the stream was down are
    // recovered by refetching on reconnect (ADR-0018 decision 4).
    const unsubscribe = globalThis.EventSource
      ? subscribeEvents({
          onEvent: (event) => {
            if (event.type === "cost_alert") reloadAlerts();
          },
          onReconnect: () => reload(),
        })
      : undefined;
    return () => {
      unsubscribe?.();
    };
  }, [reload, reloadAlerts]);

  /** Runs a mutation, then reloads; a failure is reported on the surface that started it. */
  const act = async (
    operation: () => Promise<unknown>,
    setError: (message: string) => void,
  ): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    try {
      await operation();
      setError("");
      // The reload supersedes any page begun before the mutation completed.
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  };

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canCreate) return;
    const parsed = Number(draft.threshold);
    void act(async () => {
      await api.createCostAlertRule({
        kind: draft.kind,
        window: draft.window,
        ...(draft.botId ? { botId: draft.botId as BotId } : {}),
        ...(draft.kind === "known_cost" ? { thresholdUsd: parsed } : {}),
      });
      setDraft(EMPTY_DRAFT);
    }, setRuleActionError);
  };

  // Acknowledgement can empty the current page; the hook steps back to one with rows.
  const pageAlerts = alertPages.items;
  const closeRules = useCallback(() => setRulesOpen(false), []);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="cost-alerts" aria-label={t("costAlerts.label")}>
      <header className="cost-alerts-header">
        <div className="cost-alerts-heading">
          <h2>{t("costAlerts.title")}</h2>
          {alertTotal ? (
            <Pill tone="warning">{t("costAlerts.openCount", { count: alertTotal })}</Pill>
          ) : null}
        </div>
        <div className="cost-alerts-actions">
          {ruleTotal === 0 && !rulesError ? (
            <span className="muted small">{t("costAlerts.noRules")}</span>
          ) : null}
          <Dialog modal={false} open={rulesOpen} onOpenChange={setRulesOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="secondary" size="sm" data-cost-rules-trigger="">
                {ruleTotal !== undefined
                  ? t("costAlerts.manageRules", { count: ruleTotal })
                  : t("costAlerts.manageRulesUnknown")}
              </Button>
            </DialogTrigger>
            <AlertRulesSheet
              open={rulesOpen}
              onClose={closeRules}
              rules={rulePages}
              loadError={rulesError}
              actionError={ruleActionError}
              busy={busy}
              bots={bots}
              botName={botName}
              canCreate={canCreate}
              canDelete={canDelete}
              draft={draft}
              onDraft={setDraft}
              onCreate={create}
              onCancel={() => {
                setDraft(EMPTY_DRAFT);
                setRuleActionError("");
              }}
              onDelete={(id) => void act(() => api.deleteCostAlertRule(id), setRuleActionError)}
            />
          </Dialog>
        </div>
      </header>
      {ackError ? <p role="alert">{ackError}</p> : null}
      {alertsError ? (
        <div role="alert">
          <p>{alertsError}</p>
          <Button
            type="button"
            variant="secondary"
            disabled={alertPages.loading}
            onClick={reloadAlerts}
          >
            {t("costAlerts.retryAlerts")}
          </Button>
        </div>
      ) : null}
      {alertTotal === undefined ? (
        alertsError ? null : (
          <p className="muted">{t("costAlerts.loading")}</p>
        )
      ) : alertTotal === 0 ? (
        alertsError ? null : (
          <p className="cost-alerts-empty">{t("costAlerts.noOpen")}</p>
        )
      ) : (
        <>
          <ul className="cost-alert-list" id={listId}>
            {pageAlerts.map((alert) => {
              const open = expanded.has(alert.id);
              const detailsId = `${listId}-${alert.id}`;
              return (
                <li key={alert.id} className="cost-alert-row">
                  <div className="cost-alert-summary">
                    <div className="cost-alert-facts">
                      <strong>{kindLabel(alert.kind)}</strong>
                      <span>{botName(alert.botId)}</span>
                      <span>
                        {t("costAlerts.windowKey", {
                          window: alert.window,
                          key: alert.windowKey,
                        })}
                      </span>
                      <span className="cost-alert-amount">{alertAmount(alert)}</span>
                    </div>
                    <div className="cost-alert-row-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={open}
                        aria-controls={detailsId}
                        onClick={() => toggle(alert.id)}
                      >
                        {t("costAlerts.details.toggle")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.acknowledgeCostAlert(alert.id), setAckError)
                        }
                      >
                        {t("costAlerts.acknowledge")}
                      </Button>
                    </div>
                  </div>
                  {open ? (
                    <dl className="cost-alert-details" id={detailsId}>
                      <div>
                        <dt>{t("costAlerts.details.threshold")}</dt>
                        <dd>{threshold(alert)}</dd>
                      </div>
                      <div>
                        <dt>{t("costAlerts.details.knownSpend")}</dt>
                        <dd>
                          {alert.totals.knownCostUsd === null
                            ? t("costAlerts.details.unknown")
                            : dollars(alert.totals.knownCostUsd)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("costAlerts.details.usage")}</dt>
                        <dd>
                          {t("costAlerts.details.usageValue", {
                            priced: alert.totals.pricedUsageCount,
                            unpriced: alert.totals.unpricedUsageCount,
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("costAlerts.details.runs")}</dt>
                        <dd>{alert.totals.runCount}</dd>
                      </div>
                      <div>
                        <dt>{t("costAlerts.details.fired")}</dt>
                        <dd>{utcTime(alert.firedAt)}</dd>
                      </div>
                      <div>
                        <dt>{t("costAlerts.details.run")}</dt>
                        <dd>
                          <a href={runHref(alert.runId)}>{t("costAlerts.details.openRun")}</a>
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <PageBar
            query={alertPages}
            label={t("costAlerts.pagination")}
            className="activity-pagination"
          />
        </>
      )}
    </section>
  );
}

/** HeroUI renders its select menus in a portal outside the Radix panel. */
function insideSelect(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-gb-ui="select-popover"]') !== null;
}

function AlertRulesSheet({
  open,
  onClose,
  rules,
  loadError,
  actionError,
  busy,
  bots,
  botName,
  canCreate,
  canDelete,
  draft,
  onDraft,
  onCreate,
  onCancel,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  rules: PagedQuery<CostAlertRule>;
  loadError: string;
  actionError: string;
  busy: boolean;
  bots: BotDefinition[];
  botName: (id: BotId | undefined) => string;
  canCreate: boolean;
  canDelete: boolean;
  draft: RuleDraft;
  onDraft: (update: (draft: RuleDraft) => RuleDraft) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onDelete: (id: CostAlertRule["id"]) => void;
}) {
  const t = useT();
  const thresholdId = useId();
  const set = (patch: Partial<RuleDraft>) => onDraft((current) => ({ ...current, ...patch }));
  const contentRef = useRef<HTMLDivElement>(null);
  const closedByPointer = useRef(false);
  useEffect(() => {
    if (!open) return;
    // React Aria buttons stop their pointerdown from reaching the document, which leaves Radix's
    // outside-press tracking stale after any button inside the panel is pressed; the next outside
    // press would then be ignored. Dismiss on the capture phase instead.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || contentRef.current?.contains(target)) return;
      if (insideSelect(target)) return;
      if (target instanceof Element && target.closest("[data-cost-rules-trigger]")) return;
      closedByPointer.current = true;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onClose]);
  return (
    <DialogContent
      ref={contentRef}
      className="cost-rules-sheet left-auto right-0 top-0 h-dvh max-h-dvh w-[min(480px,100vw)] translate-x-0 translate-y-0 rounded-none rounded-l-2xl max-[720px]:w-full max-[720px]:rounded-none"
      aria-describedby={undefined}
      closeLabel={t("costAlerts.rules.close")}
      onFocusOutside={(event) => event.preventDefault()}
      onInteractOutside={(event) => {
        if (insideSelect(event.target)) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        // A press elsewhere moves focus there; Escape and the close control return it to the trigger.
        if (closedByPointer.current) event.preventDefault();
        closedByPointer.current = false;
      }}
      onEscapeKeyDown={(event) => {
        // Escape in an open select menu closes the menu, not the panel.
        if (insideSelect(document.activeElement)) event.preventDefault();
      }}
    >
      <div className="cost-rules-head">
        <DialogTitle>{t("costAlerts.rules.title")}</DialogTitle>
        {rules.page?.total !== undefined ? (
          <Pill>{t("costAlerts.rules.count", { count: rules.page.total })}</Pill>
        ) : null}
      </div>
      <p className="muted small">{t("costAlerts.rules.explanation")}</p>
      <div className="cost-rules-body">
        {draft.open && canCreate ? (
          <form className="cost-rule-form" onSubmit={onCreate}>
            <Select
              disabled={busy}
              label={t("costAlerts.form.kind")}
              value={draft.kind}
              onValueChange={(value) => set({ kind: value as CostAlertKind })}
              options={[
                { value: "known_cost", label: t("costAlerts.form.kindKnownCost") },
                { value: "unpriced_usage", label: t("costAlerts.form.kindUnpricedUsage") },
              ]}
            />
            <Select
              disabled={busy}
              label={t("costAlerts.form.window")}
              value={draft.window}
              onValueChange={(value) => set({ window: value as CostAlertWindow })}
              options={[
                { value: "day", label: t("costAlerts.form.windowDay") },
                { value: "month", label: t("costAlerts.form.windowMonth") },
              ]}
            />
            <Select
              disabled={busy}
              label={t("costAlerts.form.scope")}
              value={draft.botId}
              onValueChange={(value) => set({ botId: value })}
              options={[
                { value: "", label: t("costAlerts.allBots") },
                ...bots.map((bot) => ({ value: bot.id, label: bot.name })),
              ]}
            />
            {draft.kind === "known_cost" ? (
              <div className="cost-rule-field">
                <label htmlFor={thresholdId}>{t("costAlerts.form.threshold")}</label>
                <Input
                  disabled={busy}
                  id={thresholdId}
                  type="number"
                  min="0"
                  step="any"
                  required
                  value={draft.threshold}
                  onChange={(event) => set({ threshold: event.target.value })}
                />
              </div>
            ) : null}
            {actionError ? <p role="alert">{actionError}</p> : null}
            <div className="cost-rule-form-actions">
              <Button type="button" variant="tertiary" disabled={busy} onClick={onCancel}>
                {t("costAlerts.form.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {t("costAlerts.form.create")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="cost-rules-new">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={busy || !canCreate}
              onClick={() => set({ open: true })}
            >
              {t("costAlerts.rules.new")}
            </Button>
            <RoleNote action="costRule.create" does={t("costAlerts.rules.roleNote")} />
          </div>
        )}
        {actionError && !(draft.open && canCreate) ? <p role="alert">{actionError}</p> : null}
        {loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <Button
              type="button"
              variant="secondary"
              disabled={rules.loading}
              onClick={rules.reload}
            >
              {t("costAlerts.retryRules")}
            </Button>
          </div>
        ) : null}
        {rules.page === undefined ? (
          loadError ? null : (
            <p className="muted">{t("costAlerts.rules.loading")}</p>
          )
        ) : rules.page.total === 0 ? (
          <p className="muted">{t("costAlerts.rules.none")}</p>
        ) : (
          <ul className="cost-rule-list">
            {rules.items.map((rule) => (
              <li key={rule.id}>
                <dl className="cost-rule-summary">
                  <div>
                    <dt>{t("costAlerts.rules.type")}</dt>
                    <dd>{kindLabel(rule.kind)}</dd>
                  </div>
                  <div>
                    <dt>{t("costAlerts.rules.window")}</dt>
                    <dd>{t("costAlerts.windowName", { window: rule.window })}</dd>
                  </div>
                  <div>
                    <dt>{t("costAlerts.rules.scope")}</dt>
                    <dd>{botName(rule.botId)}</dd>
                  </div>
                  <div>
                    <dt>{t("costAlerts.rules.threshold")}</dt>
                    <dd>{threshold(rule)}</dd>
                  </div>
                </dl>
                {canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDelete(rule.id)}
                  >
                    {t("costAlerts.rules.delete")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <PageBar query={rules} label={t("costAlerts.rules.pages")} />
      </div>
    </DialogContent>
  );
}
