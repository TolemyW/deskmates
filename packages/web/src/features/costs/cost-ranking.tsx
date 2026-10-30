// One ranking of the Costs page, grouped by the Gateway over the whole filtered range and read
// ten entries a page (ADR-0032 decision 9). Every value in a list has the view's unit; an entry
// with no price and no estimate says so instead of showing zero. A bar is the entry's share of
// the report's own total, so paging never rescales it.

import {
  COST_RANKING_PAGE_SIZE,
  type CostQuery,
  type CostRankingDimension,
  type CostRankingEntry,
  type CostRankingPage,
} from "@deskmates/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { CostView } from "./cost-chart.js";
import { compactTokens, hasEstimate, moneyOf, shortDollars, totalTokens } from "./cost-format.js";

export function entryLabel(entry: CostRankingEntry): string {
  return entry.workspaceName ? `${entry.label} · ${entry.workspaceName}` : entry.label;
}

interface CostRankingProps {
  api: ApiClient;
  by: CostRankingDimension;
  view: CostView;
  filters: CostQuery;
  /** The report's total in the view's unit: the bars' denominator. */
  scale: number;
  title: string;
}

export function CostRanking(props: CostRankingProps) {
  return (
    <CostRankingContent
      key={`${props.by}:${props.view}:${JSON.stringify(props.filters)}`}
      {...props}
    />
  );
}

function CostRankingContent({ api, by, view, filters, scale, title }: CostRankingProps) {
  const t = useT();
  const listId = useId();
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CostRankingPage>();
  const [error, setError] = useState("");
  const revision = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const filterKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filterKey stands for filters; retryRevision explicitly reloads.
  useEffect(() => {
    const request = ++revision.current;
    setError("");
    setPage(undefined);
    api
      .getCostRanking(by, view, filters, offset)
      .then((next) => {
        if (request === revision.current) setPage(next);
      })
      .catch((err: unknown) => {
        if (request === revision.current) setError(errorMessage(err));
      });
    return () => {
      revision.current += 1;
    };
  }, [api, by, view, filterKey, offset, retryRevision]);

  const entries = page?.entries ?? [];
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / COST_RANKING_PAGE_SIZE));
  const current = Math.floor(offset / COST_RANKING_PAGE_SIZE);

  return (
    <section className="card cost-card" aria-label={title}>
      <h3>{title}</h3>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setRetryRevision((value) => value + 1)}>
            {t("costs.ranking.retry")}
          </Button>
        </div>
      ) : !page ? (
        <p aria-busy="true">{t("costs.loading")}</p>
      ) : null}
      <ul className="cost-slices" id={listId}>
        {entries.map((entry) => {
          const money = moneyOf(entry);
          const value = view === "money" ? (money ?? 0) : totalTokens(entry);
          const width = scale > 0 ? Math.min(100, (value / scale) * 100) : 0;
          return (
            <li key={entry.key}>
              <span className="cost-slice-label" title={entry.key}>
                {entryLabel(entry)}
              </span>
              <span className="cost-slice-bar">
                <i style={{ width: `${width}%` }} />
              </span>
              <span className="cost-slice-value">
                {view === "money"
                  ? money === null
                    ? t("costs.ranking.unpriced")
                    : hasEstimate(entry)
                      ? t("costs.ranking.withEstimate", { amount: shortDollars(money) })
                      : shortDollars(money)
                  : t("costs.slice.tokens", { tokens: compactTokens(totalTokens(entry)) })}
                <span className="muted small">
                  {" "}
                  {t("costs.slice.runs", { count: entry.runCount })}
                  {view === "money" && entry.unpricedUsageCount > 0
                    ? t("costs.slice.unpriced", { count: entry.unpricedUsageCount })
                    : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {total > COST_RANKING_PAGE_SIZE ? (
        <nav className="activity-pagination" aria-label={t("costs.ranking.pagination", { title })}>
          <span className="muted small" aria-live="polite" aria-atomic="true">
            {t("costs.activity.range", {
              start: offset + 1,
              end: Math.min(offset + COST_RANKING_PAGE_SIZE, total),
              total,
            })}
          </span>
          <div className="activity-page-controls">
            <Button
              type="button"
              variant="tertiary"
              size="icon"
              aria-label={t("costs.ranking.previous", { title })}
              aria-controls={listId}
              disabled={current === 0}
              onClick={() => setOffset(offset - COST_RANKING_PAGE_SIZE)}
            >
              <ChevronLeft size={18} />
            </Button>
            <span className="small">
              {t("costs.activity.page", { page: current + 1, total: pageCount })}
            </span>
            <Button
              type="button"
              variant="tertiary"
              size="icon"
              aria-label={t("costs.ranking.next", { title })}
              aria-controls={listId}
              disabled={current + 1 >= pageCount}
              onClick={() => setOffset(offset + COST_RANKING_PAGE_SIZE)}
            >
              <ChevronRight size={18} />
            </Button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}
