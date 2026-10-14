// Workspace budgets on the Costs page (ADR-0032 decisions 1, 6 to 8): each workspace's weekly
// limit and cumulative ceiling against its spend, the work the budget parked, and the explicit
// Continue that is the only way that work resumes. Money only; tokens are not a budget.

import type { WorkspaceBudget } from "@deskmates/contracts";
import { type FormEvent, useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { RoleNote, useCan } from "../../state/session-roles.js";
import { shortDollars } from "./cost-format.js";

function parseLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function BudgetCard({
  api,
  budget,
  onChange,
}: {
  api: ApiClient;
  budget: WorkspaceBudget;
  onChange: (next: WorkspaceBudget) => void;
}) {
  const t = useT();
  const canSet = useCan("budget.set").allowed;
  const canContinue = useCan("budget.continue").allowed;
  const [editing, setEditing] = useState(false);
  const [weekly, setWeekly] = useState("");
  const [cumulative, setCumulative] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { limits, week, cumulative: total, exhausted, parks } = budget;

  const open = () => {
    setWeekly(limits.weeklyLimitUsd === null ? "" : String(limits.weeklyLimitUsd));
    setCumulative(limits.cumulativeLimitUsd === null ? "" : String(limits.cumulativeLimitUsd));
    setError("");
    setEditing(true);
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const weeklyLimitUsd = parseLimit(weekly);
    const cumulativeLimitUsd = parseLimit(cumulative);
    if (weeklyLimitUsd === undefined || cumulativeLimitUsd === undefined) {
      setError(t("costs.budget.invalidLimit"));
      return;
    }
    setBusy(true);
    setError("");
    api
      .setBudget(budget.workspaceId, { weeklyLimitUsd, cumulativeLimitUsd })
      .then((next) => {
        onChange(next);
        setEditing(false);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const resume = () => {
    setBusy(true);
    setError("");
    api
      .continueBudget(budget.workspaceId)
      .then((result) => onChange(result.budget))
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const spendLine = (spent: number, estimated: number, limit: number | null) => (
    <>
      <strong>{shortDollars(spent)}</strong>{" "}
      {limit === null
        ? t("costs.budget.noLimit")
        : t("costs.budget.ofLimit", { limit: shortDollars(limit) })}
      {estimated > 0 ? (
        <span className="muted small">
          {" "}
          {t("costs.budget.includesEstimate", { amount: shortDollars(estimated) })}
        </span>
      ) : null}
    </>
  );

  return (
    <li className="budget-card" aria-label={budget.workspaceName}>
      <div className="budget-head">
        <strong>{budget.workspaceName}</strong>
        {exhausted ? (
          <span className="budget-state" data-state="exhausted">
            {t(
              exhausted === "weekly" ? "costs.budget.weeklyReached" : "costs.budget.ceilingReached",
            )}
          </span>
        ) : null}
      </div>
      <dl className="budget-figures">
        <div>
          <dt>{t("costs.budget.week", { start: week.startsAt.slice(0, 10) })}</dt>
          <dd>{spendLine(week.spend.totalUsd, week.spend.estimatedUsd, limits.weeklyLimitUsd)}</dd>
        </div>
        <div>
          <dt>{t("costs.budget.cumulative")}</dt>
          <dd>{spendLine(total.totalUsd, total.estimatedUsd, limits.cumulativeLimitUsd)}</dd>
        </div>
      </dl>
      {parks.length > 0 ? (
        <div className="budget-parked">
          <p>
            <strong>{t("costs.budget.parkedTitle")}</strong>{" "}
            {t("costs.budget.parkedCount", { count: parks.length })}
          </p>
          <ul>
            {parks.map((park) => (
              <li key={park.id}>
                {park.botName} · <code>{park.runId}</code> ·{" "}
                {t(
                  park.checkpoint === "model_call"
                    ? "costs.budget.atModelCall"
                    : "costs.budget.beforeStart",
                )}
              </li>
            ))}
          </ul>
          {canContinue ? (
            <Button
              type="button"
              disabled={busy || exhausted !== null}
              onClick={resume}
              title={exhausted ? t("costs.budget.raiseFirst") : undefined}
            >
              {t("costs.budget.continue")}
            </Button>
          ) : (
            <RoleNote action="budget.continue" does={t("costs.budget.continueRoleNote")} />
          )}
          {exhausted ? <p className="muted small">{t("costs.budget.raiseFirst")}</p> : null}
        </div>
      ) : null}
      {editing ? (
        <form className="budget-form" onSubmit={save}>
          <label>
            {t("costs.budget.weeklyLimit")}
            <input
              inputMode="decimal"
              value={weekly}
              placeholder={t("costs.budget.noLimitPlaceholder")}
              onChange={(event) => setWeekly(event.target.value)}
            />
          </label>
          <label>
            {t("costs.budget.cumulativeLimit")}
            <input
              inputMode="decimal"
              value={cumulative}
              placeholder={t("costs.budget.noLimitPlaceholder")}
              onChange={(event) => setCumulative(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t("costs.budget.save")}
          </Button>
          <Button type="button" variant="tertiary" onClick={() => setEditing(false)}>
            {t("costAlerts.form.cancel")}
          </Button>
        </form>
      ) : canSet ? (
        <Button type="button" variant="tertiary" onClick={open}>
          {t("costs.budget.edit")}
        </Button>
      ) : (
        <RoleNote action="budget.set" does={t("costs.budget.setRoleNote")} />
      )}
      {error ? <p role="alert">{error}</p> : null}
    </li>
  );
}

export function BudgetPanel({ api }: { api: ApiClient }) {
  const t = useT();
  const [budgets, setBudgets] = useState<WorkspaceBudget[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .listBudgets()
      .then((list) => {
        if (active) setBudgets(list);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const replace = (next: WorkspaceBudget) =>
    setBudgets((list) => list?.map((b) => (b.workspaceId === next.workspaceId ? next : b)));

  return (
    <section className="card cost-card budget-panel" aria-label={t("costs.budget.title")}>
      <h3>{t("costs.budget.title")}</h3>
      <p className="muted small">{t("costs.budget.explanation")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {budgets === undefined && !error ? <p>{t("costs.budget.loading")}</p> : null}
      {budgets && budgets.length === 0 ? <p>{t("costs.budget.none")}</p> : null}
      <ul className="budget-list">
        {(budgets ?? []).map((budget) => (
          <BudgetCard key={budget.workspaceId} api={api} budget={budget} onChange={replace} />
        ))}
      </ul>
    </section>
  );
}
