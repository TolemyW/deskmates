// Knowledge › Observations › Maintenance (ADR-0011 amendment 4, issue #85 phase 2), below the
// entry list so the landing view stays the list (A21):
// - "Needs revalidation": notes that are old (1 day, owner ruling 2026-10-14), expiring, expired,
//   or an untrusted value that replaced a trusted one (A25, A26). The cheap model rechecks the
//   first three automatically (A28); the default view lists what needs a person: a replaced
//   trusted fact or a model "possibly stale". An Admin answers "Still true" or "Dismiss" (A27);
//   the flags change nothing a run receives.
// - "Automatic recheck": today's count, the latest job and the per-workspace settings (A34).
// - "Draft a document": pick trusted current notes of one topic and send them to Documents as a
//   pending proposal with citations (A29). Publishing stays the Admin review there.
// - "Organise with the cheap model" (A30 to A32): daily on its own and on request; labels become
//   topic tags, split proposals wait here for Accept or Reject, and an accepted split can be
//   undone.

import type {
  MemoryFreshnessReason,
  MemoryOrganizeJob,
  MemoryRecheckVerdict,
  MemoryRevalidation,
  MemorySplitProposal,
  WorkspaceId,
} from "@deskmates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, LearnedMemoryEntry } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { errorMessage } from "../../format.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { useCan } from "../../state/session-roles.js";
import type { MemoryMaintenanceView, MemoryTopicCount } from "./api.js";

export type MemoryMaintenanceApi = Pick<
  ApiClient,
  | "listMemoryRevalidations"
  | "decideMemoryRevalidation"
  | "getMemoryMaintenance"
  | "updateMemoryMaintenanceSettings"
  | "draftKnowledgeFromObservations"
  | "getMemoryOrganizeJob"
  | "requestMemoryOrganize"
  | "resetMemoryTopicLabels"
  | "listMemorySplits"
  | "decideMemorySplit"
  | "listMemoryTopics"
  | "listMemoryEntriesPage"
>;

const REASON_KEYS: Record<MemoryFreshnessReason, MessageKey> = {
  replaced_trusted: "observations.maintenance.reason.replacedTrusted",
  ttl_expired: "observations.maintenance.reason.ttlExpired",
  ttl_expiring: "observations.maintenance.reason.ttlExpiring",
  age: "observations.maintenance.reason.age",
};

const VERDICT_KEYS: Record<MemoryRecheckVerdict, MessageKey> = {
  still_true: "observations.maintenance.model.stillTrue",
  possibly_stale: "observations.maintenance.model.possiblyStale",
  unclear: "observations.maintenance.model.unclear",
};

type FlagView = "needs_human" | "all";

/** Notes one draft may cite (A29). */
const DRAFT_MAX = 50;

const citable = (entry: LearnedMemoryEntry) =>
  entry.kind === "note" &&
  (entry.scope === "workspace" || entry.scope === "bot") &&
  entry.live &&
  !entry.tombstoned &&
  entry.trust === "trusted";

/** One workspace's maintenance. Render it with `key={workspaceId}`. */
export function MemoryMaintenance({
  api,
  workspaceId,
}: {
  api: MemoryMaintenanceApi;
  workspaceId: WorkspaceId;
}) {
  const t = useT();
  const canRevalidate = useCan("memory.revalidate", workspaceId).allowed;
  const canDraft = useCan("memory.draftDocument", workspaceId).allowed;
  const canOrganize = useCan("memory.organize", workspaceId).allowed;
  const canSplit = useCan("memory.decideSplit", workspaceId).allowed;
  const canSettings = useCan("memory.maintenanceSettings", workspaceId).allowed;
  const [view, setView] = useState<FlagView>("needs_human");
  const [flags, setFlags] = useState<MemoryRevalidation[]>([]);
  const [flagTotals, setFlagTotals] = useState<{
    total: number;
    needsHuman: number;
    byReason: Partial<Record<MemoryFreshnessReason, number>>;
  }>({ total: 0, needsHuman: 0, byReason: {} });
  const [upkeep, setUpkeep] = useState<MemoryMaintenanceView>();
  const [limitDraft, setLimitDraft] = useState("");
  const settingsDirty = useRef(false);
  const [organizeDaily, setOrganizeDaily] = useState(true);
  const [flagCursor, setFlagCursor] = useState<string>();
  const [topics, setTopics] = useState<MemoryTopicCount[]>([]);
  const [topic, setTopic] = useState("");
  const [candidates, setCandidates] = useState<LearnedMemoryEntry[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState("");
  const [job, setJob] = useState<MemoryOrganizeJob>();
  const [splits, setSplits] = useState<MemorySplitProposal[]>([]);
  const [splitTotal, setSplitTotal] = useState(0);
  const [accepted, setAccepted] = useState<MemorySplitProposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState("");
  const readSequence = useRef(0);
  const morePending = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const request = ++readSequence.current;
    setReading(true);
    setReadError("");
    try {
      const [page, topicPage, latest, splitPage, maintenance] = await Promise.all([
        api.listMemoryRevalidations(workspaceId, { view }),
        api.listMemoryTopics(workspaceId),
        api.getMemoryOrganizeJob(workspaceId),
        api.listMemorySplits(workspaceId),
        api.getMemoryMaintenance(workspaceId),
      ]);
      if (!live.current || request !== readSequence.current) return;
      setFlags(page.revalidations);
      setFlagCursor(page.nextCursor);
      setFlagTotals({ total: page.total, needsHuman: page.needsHuman, byReason: page.byReason });
      setUpkeep(maintenance);
      if (!settingsDirty.current) {
        setLimitDraft(String(maintenance.settings.recheckDailyLimit));
        setOrganizeDaily(maintenance.settings.organizeDaily);
      }
      setTopics(topicPage.topics);
      setJob(latest);
      setSplits(splitPage.splits);
      setSplitTotal(splitPage.total);
      setLoaded(true);
    } catch (err) {
      if (live.current && request === readSequence.current) setReadError(errorMessage(err));
    } finally {
      if (live.current && request === readSequence.current) setReading(false);
    }
  }, [api, workspaceId, view]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pending organisation or recheck job is polled until it settles; nothing else polls.
  const recheckPending = upkeep?.recheck?.status === "pending";
  useEffect(() => {
    if (job?.status !== "pending" && !recheckPending) return;
    const timer = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(timer);
  }, [job, recheckPending, reload]);

  const topicLabel = topics.find((tag) => tag.key === topic)?.label ?? topic;
  useEffect(() => {
    setChosen(new Set());
    setCandidates([]);
    if (!topic) return;
    let current = true;
    api
      .listMemoryEntriesPage(workspaceId, { topic, limit: DRAFT_MAX })
      .then((page) => {
        if (!current || !live.current) return;
        setCandidates(page.entries);
        setChosen(new Set(page.entries.filter(citable).map((e) => e.id)));
        setTitle(topicLabel);
      })
      .catch((err) => {
        if (current && live.current) setError(errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [api, workspaceId, topic, topicLabel]);

  const perform = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (!live.current) return;
      setNotice(done);
      await reload();
    } catch (err) {
      if (live.current) setError(errorMessage(err));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const loadMoreFlags = async () => {
    if (!flagCursor || reading || morePending.current) return;
    const request = readSequence.current;
    morePending.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const page = await api.listMemoryRevalidations(workspaceId, { view, cursor: flagCursor });
      if (!live.current || request !== readSequence.current) return;
      setFlags((rows) => [
        ...rows,
        ...page.revalidations.filter((r) => !rows.some((x) => x.id === r.id)),
      ]);
      setFlagCursor(page.nextCursor);
    } catch (err) {
      if (live.current && request === readSequence.current) setError(errorMessage(err));
    } finally {
      morePending.current = false;
      if (live.current) setLoadingMore(false);
    }
  };

  const reasonSummary = (Object.keys(REASON_KEYS) as MemoryFreshnessReason[])
    .filter((reason) => flagTotals.byReason[reason])
    .map((reason) =>
      t("observations.maintenance.reasonCount", {
        reason: t(REASON_KEYS[reason]),
        count: flagTotals.byReason[reason] ?? 0,
      }),
    )
    .join(" · ");

  const shownTotal = view === "needs_human" ? flagTotals.needsHuman : flagTotals.total;
  const limitValue = Number(limitDraft);
  const limitValid =
    limitDraft.trim() !== "" &&
    Number.isInteger(limitValue) &&
    limitValue >= 0 &&
    limitValue <= 1000;
  const recheck = upkeep?.recheck;

  const readFailure = readError ? (
    <div>
      <p role="alert" className="error">
        {readError}
      </p>
      <Button size="sm" disabled={reading} onClick={() => void reload()}>
        {t("observations.maintenance.retry")}
      </Button>
    </div>
  ) : null;

  if (!loaded && readFailure) return readFailure;
  if (!loaded)
    return (
      <p className="muted small" aria-busy="true">
        {t("observations.maintenance.loading")}
      </p>
    );

  return (
    <div className="memory-maintenance" aria-busy={reading}>
      {readFailure}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <output className="notice">{notice}</output> : null}

      <section className="review-queue" aria-label={t("observations.maintenance.revalidate.label")}>
        <h3>{t("observations.maintenance.revalidate.title", { count: flagTotals.total })}</h3>
        <p className="muted small">{t("observations.maintenance.revalidate.intro")}</p>
        <div className="memory-flag-views">
          {(["needs_human", "all"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={view === option ? "primary" : "secondary"}
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {option === "needs_human"
                ? t("observations.maintenance.view.needsHuman", { count: flagTotals.needsHuman })
                : t("observations.maintenance.view.all", { count: flagTotals.total })}
            </Button>
          ))}
        </div>
        {shownTotal === 0 ? (
          <p className="muted small">
            {view === "needs_human" && flagTotals.total > 0
              ? t("observations.maintenance.revalidate.emptyHuman")
              : t("observations.maintenance.revalidate.empty")}
          </p>
        ) : (
          <>
            <p className="muted small">{reasonSummary}</p>
            {flags.length < shownTotal ? (
              <p className="muted small">
                {t("observations.maintenance.partial", {
                  shown: flags.length,
                  total: shownTotal,
                })}
              </p>
            ) : null}
            {flags.map((flag) => (
              <div key={flag.id} className="review-row">
                <div className="review-row-text">
                  <p className="review-row-body">{flag.entry.body}</p>
                  <p className="muted small">
                    {t(REASON_KEYS[flag.reason])} ·{" "}
                    {t("observations.maintenance.revalidate.meta", {
                      since: (flag.entry.lastConfirmedAt ?? flag.entry.effectiveAt).slice(0, 10),
                      trust: flag.entry.trust,
                    })}
                  </p>
                  {flag.model ? (
                    <p className="muted small memory-model-verdict">
                      {t(VERDICT_KEYS[flag.model.verdict], {
                        reason: flag.model.reason,
                        date: flag.model.checkedAt.slice(0, 10),
                      })}
                    </p>
                  ) : null}
                </div>
                {canRevalidate ? (
                  <div className="review-row-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api.decideMemoryRevalidation(workspaceId, flag.id, "still_true"),
                          t("observations.maintenance.revalidate.renewed"),
                        )
                      }
                    >
                      {t("observations.maintenance.revalidate.stillTrue")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api.decideMemoryRevalidation(workspaceId, flag.id, "dismiss"),
                          t("observations.maintenance.revalidate.dismissed"),
                        )
                      }
                    >
                      {t("observations.maintenance.revalidate.dismiss")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            {flagCursor ? (
              <Button
                size="sm"
                disabled={reading || loadingMore}
                aria-busy={loadingMore}
                onClick={() => void loadMoreFlags()}
              >
                {t("observations.maintenance.loadMore")}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section
        className="review-queue memory-recheck"
        aria-label={t("observations.maintenance.recheck.title")}
      >
        <h3>{t("observations.maintenance.recheck.title")}</h3>
        <p className="muted small">{t("observations.maintenance.recheck.intro")}</p>
        {upkeep ? (
          <p className="muted small">
            {upkeep.settings.recheckDailyLimit === 0
              ? t("observations.maintenance.recheck.off")
              : t("observations.maintenance.recheck.usage", {
                  used: upkeep.recheckedToday,
                  limit: upkeep.settings.recheckDailyLimit,
                })}
          </p>
        ) : null}
        {recheck ? (
          <p className="muted small">
            {recheck.status === "pending"
              ? t("observations.maintenance.recheck.pending")
              : recheck.status === "failed"
                ? t("observations.maintenance.recheck.failed", { error: recheck.error ?? "" })
                : t("observations.maintenance.recheck.ready", {
                    stillTrue: recheck.stillTrue,
                    stale: recheck.possiblyStale,
                    unclear: recheck.unclear,
                  })}
          </p>
        ) : null}
        {canSettings ? (
          <div className="memory-maintenance-settings">
            <label className="memory-draft-field">
              {t("observations.maintenance.settings.limit")}
              <input
                type="number"
                min={0}
                max={1000}
                step={1}
                value={limitDraft}
                disabled={busy}
                onChange={(event) => {
                  settingsDirty.current = true;
                  setLimitDraft(event.target.value);
                }}
              />
            </label>
            <label className="memory-draft-field">
              <input
                type="checkbox"
                checked={organizeDaily}
                disabled={busy}
                onChange={(event) => {
                  settingsDirty.current = true;
                  setOrganizeDaily(event.target.checked);
                }}
              />{" "}
              {t("observations.maintenance.settings.organizeDaily")}
            </label>
            <Button
              size="sm"
              disabled={busy || !limitValid}
              onClick={() =>
                void perform(
                  () =>
                    api
                      .updateMemoryMaintenanceSettings(workspaceId, {
                        recheckDailyLimit: limitValue,
                        organizeDaily,
                      })
                      .then((settings) => {
                        settingsDirty.current = false;
                        return settings;
                      }),
                  t("observations.maintenance.settings.saved"),
                )
              }
            >
              {t("observations.maintenance.settings.save")}
            </Button>
          </div>
        ) : null}
      </section>

      {canDraft ? (
        <section
          className="review-queue memory-draft"
          aria-label={t("observations.maintenance.draft.label")}
        >
          <h3>{t("observations.maintenance.draft.title")}</h3>
          <p className="muted small">{t("observations.maintenance.draft.intro")}</p>
          <label className="memory-draft-field">
            {t("observations.maintenance.draft.topic")}
            <select value={topic} onChange={(event) => setTopic(event.target.value)}>
              <option value="">{t("observations.maintenance.draft.chooseTopic")}</option>
              {topics.map((tag) => (
                <option key={tag.key} value={tag.key}>
                  {t("observations.topics.tag", { label: tag.label, count: tag.count })}
                </option>
              ))}
            </select>
          </label>
          {topic ? (
            <>
              <ul
                className="memory-draft-notes"
                aria-label={t("observations.maintenance.draft.notes")}
              >
                {candidates.map((entry) => (
                  <li key={entry.id}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!citable(entry)}
                        checked={chosen.has(entry.id)}
                        onChange={(event) => {
                          const next = new Set(chosen);
                          if (event.target.checked) next.add(entry.id);
                          else next.delete(entry.id);
                          setChosen(next);
                        }}
                      />{" "}
                      {entry.body}
                      {citable(entry) ? null : (
                        <span className="muted small">
                          {" "}
                          {entry.trust === "trusted"
                            ? t("observations.maintenance.draft.notCurrent")
                            : t("observations.maintenance.draft.untrusted")}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
              <label className="memory-draft-field">
                {t("observations.maintenance.draft.documentTitle")}
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || chosen.size === 0 || title.trim() === ""}
                onClick={() =>
                  void perform(
                    () =>
                      api.draftKnowledgeFromObservations(workspaceId, {
                        entryIds: [...chosen],
                        title: title.trim(),
                      }),
                    t("observations.maintenance.draft.sent", { count: chosen.size }),
                  )
                }
              >
                {t("observations.maintenance.draft.create", { count: chosen.size })}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}

      <section
        className="review-queue memory-organize"
        aria-label={t("observations.maintenance.organize.label")}
      >
        <h3>{t("observations.maintenance.organize.title")}</h3>
        <p className="muted small">{t("observations.maintenance.organize.intro")}</p>
        {job ? (
          <p className="muted small">
            {job.status === "pending"
              ? t("observations.maintenance.organize.pending")
              : job.status === "failed"
                ? t("observations.maintenance.organize.failed", { error: job.error ?? "" })
                : t("observations.maintenance.organize.ready", {
                    labels: job.labelsKept,
                    splits: job.splitsKept,
                    dropped: job.labelsDropped + job.splitsDropped,
                  })}
          </p>
        ) : null}
        {canOrganize ? (
          <div className="review-row-actions">
            <Button
              size="sm"
              disabled={busy || job?.status === "pending"}
              onClick={() =>
                void perform(
                  () => api.requestMemoryOrganize(workspaceId),
                  t("observations.maintenance.organize.requested"),
                )
              }
            >
              {t("observations.maintenance.organize.request")}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => api.resetMemoryTopicLabels(workspaceId),
                  t("observations.maintenance.organize.resetDone"),
                )
              }
            >
              {t("observations.maintenance.organize.reset")}
            </Button>
          </div>
        ) : null}
        {splitTotal > 0 ? (
          <>
            <h4>{t("observations.maintenance.splits.title", { count: splitTotal })}</h4>
            {splits.length < splitTotal ? (
              <p className="muted small">
                {t("observations.maintenance.partial", { shown: splits.length, total: splitTotal })}
              </p>
            ) : null}
            {splits.map((split) => (
              <div key={split.id} className="review-row">
                <div className="review-row-text">
                  <p className="review-row-body">{split.body}</p>
                  <ol className="memory-split-parts">
                    {split.parts.map((part, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed and ordered
                      <li key={i}>{part}</li>
                    ))}
                  </ol>
                </div>
                {canSplit ? (
                  <div className="review-row-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const done = await api.decideMemorySplit(workspaceId, split.id, "accept");
                          if (live.current) setAccepted((rows) => [done, ...rows]);
                        }, t("observations.maintenance.splits.accepted"))
                      }
                    >
                      {t("observations.maintenance.splits.accept")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api.decideMemorySplit(workspaceId, split.id, "reject"),
                          t("observations.maintenance.splits.rejected"),
                        )
                      }
                    >
                      {t("observations.maintenance.splits.reject")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
        {accepted.map((split) => (
          <div key={split.id} className="review-batch-receipt">
            <span className="muted small">
              {t("observations.maintenance.splits.receipt", { parts: split.parts.length })}
            </span>
            {canSplit ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api.decideMemorySplit(workspaceId, split.id, "undo");
                    if (live.current) setAccepted((rows) => rows.filter((r) => r.id !== split.id));
                  }, t("observations.maintenance.splits.undone"))
                }
              >
                {t("observations.maintenance.splits.undo")}
              </Button>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
