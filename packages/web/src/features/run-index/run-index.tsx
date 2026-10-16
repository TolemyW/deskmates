// The runs index (issue #11, ADR-0042 decision 2): every run of the selected workspace, newest
// first, filtered by status, bot, lane, time range, failure class and text in the error. Every
// filter is applied by the Gateway (`GET /api/runs`), so a page is never short and Load older
// walks the same filtered list. A row's text is its Activity summary when one is ready
// (ADR-0033), else the first line of its error or outcome; the row opens the run drawer.

import {
  type BotDefinition,
  type BotId,
  RUN_FAILURE_CLASSES,
  type RunFailureClass,
  type RunLane,
  type RunStatus,
  type WorkspaceId,
  isRunFailureClass,
} from "@deskmates/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import type { RunView } from "../../api/types.js";
import { Button } from "../../components/ui/button.js";
import { RUN_STATUS_LABEL, RunStatusPill } from "../../components/ui/pill.js";
import { errorMessage, formatDateTime, formatRelative } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref } from "../../router.js";
import { useWorkspaceForCalls } from "../../state/workspace-scope.js";
import type { RunListFilter } from "../runs/api.js";
import { FAILURE_CLASS_LABEL, FailureClassLabel } from "../runs/failure-class.js";
import { RunMarkBadge } from "../runs/run-mark.js";

/** Rows per page; the Gateway's default for the run list. */
export const RUN_INDEX_PAGE = 20;

/** What the filter bar holds; empty strings mean "any". */
export interface RunIndexFilters {
  status: RunStatus | "";
  botId: string;
  lane: RunLane | "";
  /** Local calendar days, `YYYY-MM-DD`; `until` is inclusive. */
  since: string;
  until: string;
  failureClass: RunFailureClass | "";
  q: string;
}

export const EMPTY_FILTERS: RunIndexFilters = {
  status: "",
  botId: "",
  lane: "",
  since: "",
  until: "",
  failureClass: "",
  q: "",
};

/** The start of a local calendar day as an ISO instant; `plusDays` moves it. */
function dayStart(day: string, plusDays = 0): string | undefined {
  const at = new Date(`${day}T00:00:00`);
  if (Number.isNaN(at.getTime())) return undefined;
  at.setDate(at.getDate() + plusDays);
  return at.toISOString();
}

/** The Gateway filter for the bar's state; the end day is included. */
export function listFilterOf(
  filters: RunIndexFilters,
  workspaceId: WorkspaceId | undefined,
): RunListFilter {
  const since = filters.since ? dayStart(filters.since) : undefined;
  const until = filters.until ? dayStart(filters.until, 1) : undefined;
  const q = filters.q.trim();
  return {
    ...(workspaceId ? { workspaceId: workspaceId } : {}),
    ...(filters.status ? { status: [filters.status] } : {}),
    ...(filters.botId ? { botId: filters.botId as BotId } : {}),
    ...(filters.lane ? { lane: filters.lane } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(filters.failureClass ? { failureClass: filters.failureClass } : {}),
    ...(q ? { q } : {}),
    limit: RUN_INDEX_PAGE,
  };
}

/** A row's one line: the ready Activity summary, else the first line of the error or outcome. */
export function rowText(run: RunView): string {
  const summary = run.activitySummary;
  if (summary?.status === "ready" && summary.text) return summary.text;
  const text = run.error ?? run.summary?.reply ?? run.summary?.done ?? "";
  const first = text.split("\n")[0]?.trim() ?? "";
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

const STATUSES = Object.keys(RUN_STATUS_LABEL) as RunStatus[];

export function RunIndexScreen({ api }: { api: ApiClient }) {
  const t = useT();
  const { workspaceId, pending } = useWorkspaceForCalls();
  const [filters, setFilters] = useState<RunIndexFilters>(EMPTY_FILTERS);
  const [text, setText] = useState("");
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // A slower answer to an older filter must not replace a newer one.
  const revision = useRef(0);

  useEffect(() => {
    if (pending) return;
    let active = true;
    api
      .listBots(workspaceId)
      .then((items) => {
        if (active) setBots(items);
      })
      .catch(() => {
        // Rows still show bot ids; only the bot filter loses its names.
      });
    return () => {
      active = false;
    };
  }, [api, workspaceId, pending]);

  const load = useCallback(
    async (next: RunIndexFilters, after?: string) => {
      const mine = ++revision.current;
      setLoading(true);
      setError(undefined);
      try {
        const page = await api.listRuns({
          ...listFilterOf(next, workspaceId),
          ...(after ? { cursor: after } : {}),
        });
        if (mine !== revision.current) return;
        setRuns((current) => (after ? [...current, ...page.runs] : page.runs));
        setCursor(page.nextCursor);
      } catch (err) {
        if (mine === revision.current) setError(errorMessage(err));
      } finally {
        if (mine === revision.current) setLoading(false);
      }
    },
    [api, workspaceId],
  );

  useEffect(() => {
    if (pending) return;
    void load(filters);
  }, [load, filters, pending]);

  const change = <K extends keyof RunIndexFilters>(key: K, value: RunIndexFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    change("q", text);
  };

  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;

  return (
    <section className="run-index" aria-label={t("runIndex.title")}>
      <header className="run-index-head">
        <h2>{t("runIndex.title")}</h2>
        <p className="muted small">{t("runIndex.intro")}</p>
      </header>
      <form className="run-index-filters" onSubmit={submitText}>
        <label>
          {t("runIndex.filter.status")}
          <select
            value={filters.status}
            onChange={(event) => change("status", event.currentTarget.value as RunStatus | "")}
          >
            <option value="">{t("runIndex.filter.any")}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {RUN_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("runIndex.filter.bot")}
          <select
            value={filters.botId}
            onChange={(event) => change("botId", event.currentTarget.value)}
          >
            <option value="">{t("runIndex.filter.any")}</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("runIndex.filter.lane")}
          <select
            value={filters.lane}
            onChange={(event) => change("lane", event.currentTarget.value as RunLane | "")}
          >
            <option value="">{t("runIndex.filter.any")}</option>
            <option value="interactive">{t("runIndex.lane.interactive")}</option>
            <option value="background">{t("runIndex.lane.background")}</option>
          </select>
        </label>
        <label>
          {t("runIndex.filter.since")}
          <input
            type="date"
            value={filters.since}
            onChange={(event) => change("since", event.currentTarget.value)}
          />
        </label>
        <label>
          {t("runIndex.filter.until")}
          <input
            type="date"
            value={filters.until}
            onChange={(event) => change("until", event.currentTarget.value)}
          />
        </label>
        <label>
          {t("runIndex.filter.failureClass")}
          <select
            value={filters.failureClass}
            onChange={(event) => {
              const value = event.currentTarget.value;
              change("failureClass", isRunFailureClass(value) ? value : "");
            }}
          >
            <option value="">{t("runIndex.filter.any")}</option>
            {RUN_FAILURE_CLASSES.map((failureClass) => (
              <option key={failureClass} value={failureClass}>
                {t(FAILURE_CLASS_LABEL[failureClass])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("runIndex.filter.text")}
          <input
            type="search"
            value={text}
            placeholder={t("runIndex.filter.textPlaceholder")}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <Button size="sm" type="submit">
          {t("runIndex.filter.search")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setText("");
            setFilters(EMPTY_FILTERS);
          }}
        >
          {t("runIndex.filter.clear")}
        </Button>
      </form>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && runs.length === 0 && !error ? (
        <p className="muted small">{t("runIndex.empty")}</p>
      ) : null}
      <ol className="run-index-list" aria-label={t("runIndex.list")}>
        {runs.map((run) => {
          const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
          return (
            <li key={run.id} className="run-index-row" data-testid="run-index-row">
              <a href={runHref(run.id)}>
                <span className="run-index-meta">
                  <time dateTime={at} title={formatDateTime(at)} className="muted small">
                    {formatRelative(at)}
                  </time>
                  <strong>{botName(run.botId)}</strong>
                  <span className="muted small">
                    {t(
                      run.lane === "interactive"
                        ? "runIndex.lane.interactive"
                        : "runIndex.lane.background",
                    )}
                  </span>
                  <RunStatusPill status={run.status} />
                  <FailureClassLabel failureClass={run.failureClass} />
                  <RunMarkBadge mark={run.mark} />
                </span>
                <span className="run-index-text">{rowText(run)}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {cursor ? (
        <Button size="sm" disabled={loading} onClick={() => void load(filters, cursor)}>
          {loading ? t("runIndex.loadingOlder") : t("runIndex.loadOlder")}
        </Button>
      ) : null}
    </section>
  );
}
