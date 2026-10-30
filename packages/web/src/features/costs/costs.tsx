import {
  ChoiceGroup,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deskmates/ui";
import { Select } from "@deskmates/ui";
// Costs, one page with two views (ADR-0032 decision 9). A 金额 | 用量 (money | usage) toggle at
// the top switches the tiles, the daily chart and the rankings together; the page opens on money
// every time. Money shows one total and folds the known, estimated and unpriced breakdown under
// "How it's priced"; usage shows the four token categories. No list or scale mixes the two.
// Totals and days come from the `GET /api/costs` summary, rankings from the Gateway's grouped
// `GET /api/costs/ranking` and Activity rows from `GET /api/costs/rows`, ten a page each; nothing
// is summed from a page in the browser (#112, #113).
// ADR-0040 amendment A: operation calls are in the money totals, chart and bot ranking, have a
// ranking of their own in money view, and one usage tile per unit; no unit is summed with another.

import type {
  BotDefinition,
  BotId,
  CostDay,
  CostOperationUsage,
  CostQuery,
  CostReport,
  CostRow,
  CostTotals,
} from "@deskmates/contracts";
import { CalendarRange } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { PageBar } from "../../lib/page-bar.js";
import { usePagedQuery } from "../../lib/use-paged-query.js";
import { BudgetPanel } from "./budget-panel.js";
import { CostAlertsPanel } from "./cost-alerts.js";
import { CostChart, type CostView } from "./cost-chart.js";
import {
  compactTokens,
  dollars,
  hasEstimate,
  moneyOf,
  operationQuantity,
  shortDollars,
  tokens,
  totalTokens,
} from "./cost-format.js";
import { CostRanking } from "./cost-ranking.js";

export { compactTokens, shortDollars } from "./cost-format.js";

function costLabel(cost: CostTotals): string {
  const { t } = currentI18n();
  const estimate = cost.estimatedCostUsd ?? null;
  if (cost.costStatus === "unpriced" || cost.knownCostUsd === null) {
    return estimate !== null
      ? t("costs.estimateOnly", { estimate: dollars(estimate) })
      : t("costs.unpricedRows", { count: cost.unpricedUsageCount });
  }
  if (cost.costStatus === "partial") {
    return estimate !== null
      ? t("costs.knownPlusEstimate", {
          known: dollars(cost.knownCostUsd),
          estimate: dollars(estimate),
        })
      : t("costs.knownPlusUnpriced", {
          known: dollars(cost.knownCostUsd),
          count: cost.unpricedUsageCount,
        });
  }
  return dollars(cost.knownCostUsd);
}

type Period = "today" | "7d" | "30d" | "all" | "custom";

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The inclusive UTC day range of a period; `all` and `custom` leave the dates alone. The Gateway
 * buckets costs by UTC day, so the period buttons say UTC rather than imply the person's own day.
 */
export function periodRange(period: Period, now = new Date()): { from?: string; to?: string } {
  const to = isoDay(now);
  if (period === "today") return { from: to, to };
  if (period === "7d") return { from: isoDay(new Date(now.getTime() - 6 * 86_400_000)), to };
  if (period === "30d") return { from: isoDay(new Date(now.getTime() - 29 * 86_400_000)), to };
  return {};
}

/** The report's days, or, from a Gateway that predates them, the rows summed by day. */
export function daysOf(report: CostReport): CostDay[] {
  if (report.days) return report.days;
  const days = new Map<string, CostDay>();
  for (const row of report.rows ?? []) {
    const day = days.get(row.day) ?? {
      day: row.day,
      runCount: 0,
      usageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      pricedUsageCount: 0,
      unpricedUsageCount: 0,
      knownCostUsd: null,
      costStatus: "unpriced",
      estimatedCostUsd: null,
    };
    day.inputTokens += row.inputTokens;
    day.outputTokens += row.outputTokens;
    day.cacheReadTokens += row.cacheReadTokens;
    day.cacheCreateTokens += row.cacheCreateTokens;
    if (row.knownCostUsd !== null) day.knownCostUsd = (day.knownCostUsd ?? 0) + row.knownCostUsd;
    if (row.estimatedCostUsd != null)
      day.estimatedCostUsd = (day.estimatedCostUsd ?? 0) + row.estimatedCostUsd;
    days.set(row.day, day);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Activity rows: ten a page from the Gateway (#113). */
export const ACTIVITY_PAGE_SIZE = 10;

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="cost-tile">
      <span className="cost-tile-label">{label}</span>
      <strong>{value}</strong>
      {detail ? <span className="muted small">{detail}</span> : null}
    </div>
  );
}

function MoneyTiles({
  totals,
  operations,
  estimateVersion,
}: {
  totals: CostTotals;
  operations: CostOperationUsage | undefined;
  estimateVersion: string;
}) {
  const t = useT();
  const [pricingOpen, setPricingOpen] = useState(false);
  const money = moneyOf(totals);
  const estimate = totals.estimatedCostUsd ?? null;
  const unknown = totals.usageCount === 0 && totals.usageCoverage !== "unknown";
  return (
    <div className="cost-money">
      <Tile
        label={hasEstimate(totals) ? t("costs.tile.totalWithEstimate") : t("costs.tile.total")}
        value={
          unknown
            ? t("costs.tile.noUsage")
            : money === null
              ? t("costs.tile.unknown")
              : shortDollars(money)
        }
        detail={totals.usageCount === 0 || totals.costStatus === "priced" ? "" : costLabel(totals)}
      />
      {totals.usageCount > 0 ? (
        <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
          <DialogTrigger asChild>
            <Button variant="tertiary" size="sm" className="cost-pricing-link">
              {t("costs.pricing.title")}
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-w-lg overflow-y-auto cost-pricing"
            closeLabel={t("costs.pricing.close")}
          >
            <DialogTitle>{t("costs.pricing.title")}</DialogTitle>
            <DialogDescription>{t("costs.lead")}</DialogDescription>
            <p>
              {t("costs.money.known")}:{" "}
              {totals.knownCostUsd === null
                ? t("costs.tile.unknown")
                : shortDollars(totals.knownCostUsd)}{" "}
              · {t("costs.tile.pricedRows", { count: totals.pricedUsageCount })}
            </p>
            <p>
              {t("costs.money.estimated")}: {estimate === null ? "—" : shortDollars(estimate)} ·{" "}
              {t("costs.tile.estimateDetail", { count: totals.estimatedUsageCount ?? 0 })}
            </p>
            <p>
              {t("costs.tile.unpricedCount", { count: totals.unpricedUsageCount })} ·{" "}
              {(totals.unestimatedUsageCount ?? 0) > 0
                ? t("costs.tile.unestimated", { count: totals.unestimatedUsageCount ?? 0 })
                : operations
                  ? t("costs.tile.requestsWithOperations", { count: totals.usageCount })
                  : t("costs.tile.requests", { count: totals.usageCount })}
            </p>
            {estimate !== null ? (
              <p>{t("costs.estimateNote", { version: estimateVersion })}</p>
            ) : null}
            {operations ? <p className="muted small">{t("costs.operations.note")}</p> : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function UsageTiles({
  totals,
  operations,
}: {
  totals: CostTotals;
  operations: CostOperationUsage | undefined;
}) {
  const t = useT();
  const unknown = totals.usageCoverage === "unknown";
  const tile = (label: MessageKey, value: number) => (
    <Tile
      key={label}
      label={t(label)}
      value={unknown ? "—" : compactTokens(value)}
      detail={unknown ? "—" : tokens(value)}
    />
  );
  return (
    <>
      {tile("costs.activity.input", totals.inputTokens)}
      {tile("costs.activity.output", totals.outputTokens)}
      {tile("costs.activity.cacheRead", totals.cacheReadTokens)}
      {tile("costs.activity.cacheCreate", totals.cacheCreateTokens)}
      {operations?.units.map((u) => (
        <Tile
          key={`operation:${u.unit}`}
          label={t(`costs.operations.unit.${u.unit}`)}
          value={operationQuantity(u.unit, u.quantity)}
          detail={t("costs.operations.detail", { calls: u.callCount, unknown: u.unmeasuredCount })}
        />
      ))}
    </>
  );
}

export function CostsScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [report, setReport] = useState<CostReport>();
  const [view, setView] = useState<CostView>("money");
  const [applied, setApplied] = useState<CostQuery>({});
  const [period, setPeriod] = useState<Period>("30d");
  const initial = useMemo(() => periodRange("30d"), []);
  const [from, setFrom] = useState(initial.from ?? "");
  const [to, setTo] = useState(initial.to ?? "");
  const [botId, setBotId] = useState("");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRevision = useRef(0);
  const requestedFilters = useRef<CostQuery>({});

  const load = useCallback(
    (filters: CostQuery): void => {
      const request = ++requestRevision.current;
      requestedFilters.current = filters;
      setLoading(true);
      setError("");
      void api
        .getCosts(filters)
        .then((next) => {
          if (request === requestRevision.current) {
            setReport(next);
            setApplied(filters);
          }
        })
        .catch((err: unknown) => {
          if (request === requestRevision.current) setError(errorMessage(err));
        })
        .finally(() => {
          if (request === requestRevision.current) setLoading(false);
        });
    },
    [api],
  );

  const filtersFor = (range: { from?: string; to?: string }): CostQuery => ({
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(botId ? { botId: botId as BotId } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
  });

  useEffect(() => {
    let active = true;
    api
      .listBots()
      .then((items) => {
        if (active) setBots(items);
      })
      .catch(() => {
        // Bot names in the rows still make the report useful; only the select loses its options.
      });
    load({
      ...(initial.from ? { from: initial.from } : {}),
      ...(initial.to ? { to: initial.to } : {}),
    });
    return () => {
      active = false;
      requestRevision.current += 1;
    };
  }, [api, load, initial]);

  const pick = (next: Period) => {
    setPeriod(next);
    if (next === "custom") return;
    const range = periodRange(next);
    setFrom(range.from ?? "");
    setTo(range.to ?? "");
    load(filtersFor(range));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setPeriod("custom");
    load(filtersFor({ from, to }));
  };

  const totals = report?.totals;
  const operations = report?.operations?.units.length ? report.operations : undefined;
  const days = useMemo(() => (report ? daysOf(report) : []), [report]);
  const scale = totals ? (view === "money" ? (moneyOf(totals) ?? 0) : totalTokens(totals)) : 0;

  const periods: { key: Period; label: MessageKey }[] = [
    { key: "today", label: "costs.period.today" },
    { key: "7d", label: "costs.period.sevenDays" },
    { key: "30d", label: "costs.period.thirtyDays" },
    { key: "all", label: "costs.period.all" },
  ];
  const views: { key: CostView; label: MessageKey }[] = [
    { key: "money", label: "costs.view.money" },
    { key: "usage", label: "costs.view.usage" },
  ];

  return (
    <section className="costs-screen page-container">
      <PageHeader title={t("costs.title")} />
      <div className="costs-controls">
        <ChoiceGroup
          label={t("costs.view.label")}
          value={view}
          onChange={setView}
          items={views.map((v) => ({ key: v.key, label: t(v.label) }))}
        />
        <ChoiceGroup
          label={t("costs.period.label")}
          value={period}
          onChange={pick}
          items={[
            ...periods.map((p) => ({ key: p.key, label: t(p.label) })),
            { key: "custom", label: t("costs.period.custom"), icon: <CalendarRange size={16} /> },
          ]}
        />
      </div>

      <form className={`cost-filters${period === "custom" ? "" : " collapsed"}`} onSubmit={submit}>
        <label>
          {t("costs.filter.from")}
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          {t("costs.filter.to")}
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <Select
          label={t("costs.filter.bot")}
          value={botId}
          onValueChange={(value) => setBotId(value)}
          options={[
            {
              value: "",
              label: t("costs.filter.allBots"),
            },
            ...bots.map((bot) => ({
              value: bot.id,
              label: bot.name,
            })),
          ]}
        />

        <label>
          {t("costs.filter.model")}
          <input
            value={model}
            placeholder={t("costs.filter.modelPlaceholder")}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={loading}>
          {t("costs.filter.apply")}
        </Button>
      </form>

      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => load(requestedFilters.current)}>{t("costs.retry")}</Button>
        </div>
      ) : null}
      {loading ? <p>{t("costs.loading")}</p> : null}
      {!loading && !error && totals ? (
        <>
          <div className="cost-summary-notes muted small">
            {totals.usageCoverage && totals.usageCoverage !== "complete" ? (
              <span>{t(`run.usage.${totals.usageCoverage}`)}</span>
            ) : null}
            {totals.attributionUncertain ? (
              <span>{t("run.usage.attributionUncertain")}</span>
            ) : null}
          </div>
          <section className="cost-tiles" aria-label={t("costs.totals.label")}>
            {view === "money" ? (
              <MoneyTiles
                totals={totals}
                operations={operations}
                estimateVersion={report?.estimate?.version ?? ""}
              />
            ) : (
              <UsageTiles totals={totals} operations={operations} />
            )}
          </section>
        </>
      ) : null}
      {/* Open alerts come before the charts and Activity; they ignore the report filters and
          stay mounted while the report reloads, so their live subscription is never torn down. */}
      <CostAlertsPanel api={api} bots={bots} />
      <BudgetPanel api={api} />
      {!loading && !error && totals ? (
        <>
          {days.length === 0 ? (
            <p>{t("costs.noMatch")}</p>
          ) : (
            <>
              <section className="card cost-card">
                <h3>
                  {view === "money" ? t("costs.chart.spendTitle") : t("costs.chart.tokensTitle")}
                </h3>
                <CostChart days={days} view={view} />
              </section>
              <div className="cost-breakdowns">
                <CostRanking
                  api={api}
                  by="model"
                  view={view}
                  filters={applied}
                  scale={scale}
                  title={t("costs.byModel")}
                />
                <CostRanking
                  api={api}
                  by="bot"
                  view={view}
                  filters={applied}
                  scale={scale}
                  title={t("costs.byBot")}
                />
                {view === "money" && operations ? (
                  <CostRanking
                    api={api}
                    by="operation"
                    view={view}
                    filters={applied}
                    scale={scale}
                    title={t("costs.byOperation")}
                  />
                ) : null}
              </div>
              <CostActivity api={api} filters={applied} />
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

/**
 * The Activity table: one row per day, bot and model, ten a page by keyset from the Gateway
 * (#113). Applying filters starts again at the first page; a late page of an older filter is
 * dropped. The rows are a breakdown only: totals and days never come from them.
 */
function CostActivity({ api, filters }: { api: ApiClient; filters: CostQuery }) {
  const t = useT();
  const pages = usePagedQuery<CostRow>({
    scopeKey: `costs.activity:${JSON.stringify(filters)}`,
    limit: ACTIVITY_PAGE_SIZE,
    mode: "cursor",
    historyKey: "costs.activity",
    fetchPage: async ({ cursor, limit }) => {
      const page = await api.getCostRows(filters, { ...(cursor ? { cursor } : {}), limit });
      return {
        items: page.rows,
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  });
  return (
    <section className="card cost-card">
      <h3>{t("costs.activity.title")}</h3>
      {pages.error ? <p role="alert">{errorMessage(pages.error)}</p> : null}
      <Table id="cost-activity-table" aria-label={t("costs.activity.label")}>
        <caption className="sr-only">{t("costs.activity.caption")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("costs.activity.day")}</TableHead>
            <TableHead scope="col">{t("costs.activity.bot")}</TableHead>
            <TableHead scope="col">{t("costs.activity.model")}</TableHead>
            <TableHead scope="col">{t("costs.activity.runs")}</TableHead>
            <TableHead scope="col">{t("costs.activity.input")}</TableHead>
            <TableHead scope="col">{t("costs.activity.output")}</TableHead>
            <TableHead scope="col">{t("costs.activity.cacheRead")}</TableHead>
            <TableHead scope="col">{t("costs.activity.cacheCreate")}</TableHead>
            <TableHead scope="col">{t("costs.activity.cost")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pages.items.map((row: CostRow) => (
            <TableRow key={`${row.day}:${row.botId}:${row.model}`}>
              <TableCell>{row.day}</TableCell>
              <TableCell>
                {row.workspaceName ? `${row.botName} · ${row.workspaceName}` : row.botName}
              </TableCell>
              <TableCell>
                <code>{row.model}</code>
              </TableCell>
              <TableCell>{tokens(row.runCount)}</TableCell>
              <TableCell>{tokens(row.inputTokens)}</TableCell>
              <TableCell>{tokens(row.outputTokens)}</TableCell>
              <TableCell>{tokens(row.cacheReadTokens)}</TableCell>
              <TableCell>{tokens(row.cacheCreateTokens)}</TableCell>
              <TableCell>{costLabel(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PageBar
        query={pages}
        label={t("costs.activity.pagination")}
        className="activity-pagination"
      />
    </section>
  );
}
