// Knowledge › Observations (issue #27; the former Facts tab): the dated facts the bots of one
// workspace learned, with provenance and validity (ADR-0011). A row leads with what was learned
// and one source line; a badge appears only when the entry needs an action. Validity, trust,
// versions and technical provenance are in the detail panel; Edit, Forget and Versions sit in
// the row's action menu. Items held by the confirmation gate are listed above, only when some
// wait. Bot experience stays on each bot's profile and task notes on their chat.
//
// ADR-0011 amendment 3: the waiting items are shown as review groups (one proposal made in
// several runs is one group with every wording and source), an Admin may reject or merge a group
// in one previewed and undoable batch (A18, A19, proposed), and topic tags filter the list (A20).
// Every list pages with "Load more" or "Load older" (#113 slice K2).

import type {
  BotDefinition,
  MemoryBatchDecision,
  MemoryBatchPreview,
  MemoryConfirmation,
  MemoryReviewGroup,
  MemoryVersion,
  WorkspaceId,
} from "@deskmates/contracts";
import { ActionMenu, type ActionMenuItem } from "@deskmates/ui";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, LearnedMemoryEntry } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Pill } from "../../components/ui/pill.js";
import { errorMessage } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref } from "../../router.js";
import { useCan } from "../../state/session-roles.js";
import type { MemoryProvenance, MemoryReviewGroupsPage, MemoryTopicCount } from "./api.js";
import {
  AUTHORITY_LABELS,
  KIND_LABELS,
  OP_LABELS,
  REASON_LABELS,
  SCOPE_LABELS,
  SOURCE_KIND_LABELS,
  SUPERSESSION_LABELS,
  SourceCell,
  TRUST_LABELS,
  ageOf,
  appendNew,
  label,
  validityOf,
} from "./learned-memory.js";

export type ObservationsApi = Pick<
  ApiClient,
  | "listBots"
  | "listMemoryEntriesPage"
  | "listMemoryReviewGroups"
  | "listMemoryTopics"
  | "memoryProvenance"
  | "searchLearnedMemoryPage"
  | "editMemoryEntry"
  | "forgetMemoryEntry"
  | "undoMemoryEntry"
  | "confirmMemoryEntry"
  | "reviewMemorySuggestion"
  | "listMemoryVersionsPage"
  | "previewMemoryBatch"
  | "commitMemoryBatch"
  | "undoMemoryBatch"
>;

/** Topic tags shown above the list; the rest are counted, never dropped silently. */
const TOPIC_PAGE = 25;

/** A short name for a row in an accessible label: the first words of its text. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/**
 * One workspace's observations. Render it with `key={workspaceId}`: a new workspace starts
 * from a fresh panel, so no row, selection, draft or late answer of the previous one shows.
 */
export function ObservationsPanel({
  api,
  workspaceId,
  now = () => new Date(),
}: {
  api: ObservationsApi;
  workspaceId: WorkspaceId;
  now?: () => Date;
}) {
  const t = useT();
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);
  const [entries, setEntries] = useState<LearnedMemoryEntry[]>([]);
  const [groups, setGroups] = useState<MemoryReviewGroup[]>([]);
  const [groupTotals, setGroupTotals] = useState({ groups: 0, items: 0 });
  const [batches, setBatches] = useState<MemoryReviewGroupsPage["batches"]>([]);
  const [preview, setPreview] = useState<MemoryBatchPreview>();
  const [topics, setTopics] = useState<{ topics: MemoryTopicCount[]; total: number }>({
    topics: [],
    total: 0,
  });
  const [topic, setTopic] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; body: string; version: number }>();
  const [forgetting, setForgetting] = useState<string>();
  const [versions, setVersions] = useState<{
    id: string;
    items: MemoryVersion[];
    nextCursor?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [groupCursor, setGroupCursor] = useState<string>();
  const [entryCursor, setEntryCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState<"pending" | "entries">();
  const [provenance, setProvenance] = useState<MemoryProvenance & { id: string }>();
  const reloadSeq = useRef(0);
  const versionsSeq = useRef(0);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const live = useRef(true);
  // Batch dispositions decide gated items like a single review (ADR-0011 amendment 3, A18).
  const canReview = useCan("memory.reviewSuggestion").allowed;
  // Set on every mount: StrictMode mounts, unmounts and mounts again in development.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api
      .listBots(workspaceId)
      .then((list) => active && setBots(list))
      .catch(() => {
        // Names fall back to ids; the list itself reports its own failure.
      });
    return () => {
      active = false;
    };
  }, [api, workspaceId]);

  const visible = useCallback(
    (list: readonly LearnedMemoryEntry[]) =>
      list.filter((item) => item.scope !== "bot" && (showHistory || item.live)),
    [showHistory],
  );

  const entryFilters = useCallback(
    () => ({ includeForgotten: showHistory, ...(topic ? { topic } : {}) }),
    [showHistory, topic],
  );

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setLoaded(false);
    setLoadError("");
    const query = search.trim();
    try {
      const [nextEntries, nextGroups, nextTopics] = await Promise.all([
        query
          ? api.searchLearnedMemoryPage(workspaceId, query)
          : api.listMemoryEntriesPage(workspaceId, entryFilters()),
        api.listMemoryReviewGroups(workspaceId),
        api.listMemoryTopics(workspaceId, { limit: TOPIC_PAGE }),
      ]);
      if (seq !== reloadSeq.current || !live.current) return;
      setEntries(visible(nextEntries.entries));
      setEntryCursor(nextEntries.nextCursor);
      setGroups(nextGroups.groups);
      setGroupCursor(nextGroups.nextCursor);
      setGroupTotals({ groups: nextGroups.totalGroups, items: nextGroups.totalItems });
      setBatches(nextGroups.batches);
      setTopics(nextTopics);
      setLoadError("");
    } catch (err) {
      if (seq !== reloadSeq.current || !live.current) return;
      setLoadError(errorMessage(err));
    } finally {
      if (seq === reloadSeq.current && live.current) setLoaded(true);
    }
  }, [api, workspaceId, search, visible, entryFilters]);

  useEffect(() => {
    void reload();
    return () => {
      reloadSeq.current += 1;
    };
  }, [reload]);

  // ADR-0011 A15: later pages are loaded on request and appended; nothing is dropped silently.
  const loadMore = async (which: "pending" | "entries") => {
    const seq = reloadSeq.current;
    setLoadingMore(which);
    try {
      if (which === "pending" && groupCursor) {
        const page = await api.listMemoryReviewGroups(workspaceId, { cursor: groupCursor });
        if (seq !== reloadSeq.current || !live.current) return;
        setGroups((current) => [
          ...current,
          ...page.groups.filter((g) => !current.some((c) => c.groupKey === g.groupKey)),
        ]);
        setGroupCursor(page.nextCursor);
      } else if (which === "entries" && entryCursor) {
        const page = search.trim()
          ? await api.searchLearnedMemoryPage(workspaceId, search.trim(), { cursor: entryCursor })
          : await api.listMemoryEntriesPage(workspaceId, {
              ...entryFilters(),
              cursor: entryCursor,
            });
        if (seq !== reloadSeq.current || !live.current) return;
        setEntries((current) => appendNew(current, visible(page.entries)));
        setEntryCursor(page.nextCursor);
      }
    } catch (err) {
      if (live.current) setError(errorMessage(err));
    } finally {
      if (live.current) setLoadingMore(undefined);
    }
  };

  useEffect(() => {
    let active = true;
    setProvenance(undefined);
    if (!selectedId) return;
    api
      .memoryProvenance(selectedId)
      .then((value) => active && setProvenance({ id: selectedId, ...value }))
      .catch(() => {
        // Provenance is supplementary; the entry's own source line still shows.
      });
    return () => {
      active = false;
    };
  }, [api, selectedId]);

  const perform = async (operation: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await reload();
      if (live.current) setNotice(done);
    } catch (err) {
      if (live.current) setError(errorMessage(err));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const open = (id: string) => {
    if (id !== selectedId) {
      versionsSeq.current += 1;
      setLoadingVersions(false);
      setEditing(undefined);
      setForgetting(undefined);
      setVersions(undefined);
    }
    setSelectedId(id);
  };
  const close = () => {
    versionsSeq.current += 1;
    setLoadingVersions(false);
    setSelectedId(undefined);
    setEditing(undefined);
    setForgetting(undefined);
    setVersions(undefined);
  };
  const showVersions = (id: string, cursor?: string) => {
    if (!cursor) open(id);
    const request = ++versionsSeq.current;
    setLoadingVersions(true);
    setError("");
    api
      .listMemoryVersionsPage(id, cursor ? { cursor } : {})
      .then(
        (page) =>
          live.current &&
          request === versionsSeq.current &&
          setVersions((current) => ({
            id,
            // Newest first; "Load older" appends without repeating a version (#113 K2).
            items:
              cursor && current?.id === id
                ? appendNew(
                    current.items.map((v) => ({ ...v, id: String(v.version) })),
                    page.versions.map((v) => ({ ...v, id: String(v.version) })),
                  )
                : page.versions,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          })),
      )
      .catch((err: unknown) => {
        if (live.current && request === versionsSeq.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (live.current && request === versionsSeq.current) setLoadingVersions(false);
      });
  };

  const startBatch = (group: MemoryReviewGroup, decision: MemoryBatchDecision) => {
    setError("");
    api
      .previewMemoryBatch(workspaceId, { groupKey: group.groupKey, decision })
      .then((value) => live.current && setPreview(value))
      .catch((err: unknown) => live.current && setError(errorMessage(err)));
  };
  const commitBatch = (value: MemoryBatchPreview) =>
    void perform(
      async () => {
        await api.commitMemoryBatch(workspaceId, {
          groupKey: value.groupKey,
          decision: value.decision,
          token: value.token,
        });
        setPreview(undefined);
      },
      t(value.decision === "merge" ? "observations.batch.merged" : "observations.batch.rejected"),
    );
  const lastBatch = batches[0] && !batches[0].undoneAt ? batches[0] : undefined;

  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const at = now();
  const selected = entries.find((item) => item.id === selectedId);

  const who = (item: LearnedMemoryEntry) =>
    item.sourceKind === "human"
      ? t("observations.who.person")
      : (item.learnedBy ?? t("learnedMemory.source.aBot"));
  const stateText = (item: LearnedMemoryEntry) =>
    item.tombstoned || !item.live ? validityOf(item) : undefined;

  const menuItems = (item: LearnedMemoryEntry): ActionMenuItem[] =>
    item.tombstoned
      ? [
          {
            id: "versions",
            label: t("learnedMemory.action.versions"),
            onAction: () => showVersions(item.id),
          },
        ]
      : [
          {
            id: "edit",
            label: t("learnedMemory.action.edit"),
            disabled: busy,
            onAction: () => {
              open(item.id);
              setForgetting(undefined);
              setEditing({ id: item.id, body: item.body, version: item.version });
            },
          },
          {
            id: "versions",
            label: t("learnedMemory.action.versions"),
            onAction: () => showVersions(item.id),
          },
          ...(item.version > 1
            ? [
                {
                  id: "undo",
                  label: t("learnedMemory.action.undo"),
                  disabled: busy,
                  onAction: () =>
                    void perform(
                      () => api.undoMemoryEntry(item.id),
                      t("learnedMemory.notice.undone"),
                    ),
                },
              ]
            : []),
          ...(item.trust === "untrusted"
            ? [
                {
                  id: "confirm",
                  label: t("learnedMemory.action.confirm"),
                  disabled: busy,
                  onAction: () =>
                    void perform(
                      () => api.confirmMemoryEntry(item.id),
                      t("learnedMemory.notice.confirmed"),
                    ),
                },
              ]
            : []),
          {
            id: "forget",
            label: t("learnedMemory.action.forget"),
            disabled: busy,
            tone: "danger",
            onAction: () => {
              open(item.id);
              setEditing(undefined);
              setForgetting(item.id);
            },
          },
        ];

  const reviewRow = (item: MemoryConfirmation) => (
    <div key={item.id} className="review-row">
      <div className="review-row-text">
        <p className="review-row-body">{item.body}</p>
        <p className="muted small">
          {t("observations.review.meta", {
            bot: botName(item.botId),
            reasons:
              item.reasons.length > 0
                ? item.reasons.map((reason) => label(REASON_LABELS, reason)).join("; ")
                : t("learnedMemory.confirmations.legacy"),
          })}{" "}
          · <a href={runHref(item.runId)}>{t("learnedMemory.confirmations.sourceRun")}</a>
        </p>
      </div>
      <div className="review-row-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(
              () => api.reviewMemorySuggestion(item.id, { decision: "apply" }),
              t("learnedMemory.notice.approved"),
            )
          }
        >
          {t("learnedMemory.confirmations.approve")}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(
              () => api.reviewMemorySuggestion(item.id, { decision: "reject" }),
              t("learnedMemory.notice.rejected"),
            )
          }
        >
          {t("learnedMemory.confirmations.reject")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="observations">
      <div className="resource-toolbar">
        <label className="resource-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("learnedMemory.search.label")}
            placeholder={t("observations.search.placeholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="resource-toggle">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(event) => setShowHistory(event.target.checked)}
          />
          {t("learnedMemory.showHistory")}
        </label>
        {search.trim() && showHistory ? (
          <p className="muted small">{t("learnedMemory.search.activeOnly")}</p>
        ) : null}
        {search.trim() ? (
          <p className="muted small">{t("observations.search.bestMatches")}</p>
        ) : null}
      </div>
      {groupTotals.items > 0 ? (
        <section className="review-queue" aria-label={t("observations.review.label")}>
          <h2>
            {groupTotals.groups === groupTotals.items
              ? t("observations.review.title", { count: groupTotals.items })
              : t("observations.review.titleGroups", {
                  count: groupTotals.items,
                  groups: groupTotals.groups,
                })}
          </h2>
          <ul>
            {groups.map((group) => (
              <li
                key={group.groupKey}
                className="review-group"
                aria-label={t("observations.review.groupLabel", {
                  name: snippet(group.items[0]?.body ?? ""),
                })}
              >
                {group.count > 1 ? (
                  <p className="review-group-head muted small">
                    {t("observations.review.groupCount", { count: group.count })}
                  </p>
                ) : null}
                {group.items.map((item) => reviewRow(item))}
                {group.count > group.items.length ? (
                  <p className="muted small">
                    {t("observations.review.groupMore", {
                      count: group.count - group.items.length,
                    })}
                  </p>
                ) : null}
                {canReview && group.count > 1 ? (
                  <div className="review-row-actions">
                    <Button size="sm" disabled={busy} onClick={() => startBatch(group, "merge")}>
                      {t("observations.batch.merge", { count: group.count })}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => startBatch(group, "reject")}>
                      {t("observations.batch.reject", { count: group.count })}
                    </Button>
                  </div>
                ) : null}
                {preview?.groupKey === group.groupKey ? (
                  <div
                    className="resource-confirm"
                    role="alertdialog"
                    aria-label={t("observations.batch.previewLabel")}
                  >
                    <p>
                      {t(
                        preview.decision === "merge"
                          ? "observations.batch.previewMerge"
                          : "observations.batch.previewReject",
                        { count: preview.itemIds.length },
                      )}
                    </p>
                    {preview.remaining > 0 ? (
                      <p className="muted small">
                        {t("observations.batch.previewRemaining", { count: preview.remaining })}
                      </p>
                    ) : null}
                    <div className="resource-detail-actions">
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => commitBatch(preview)}
                      >
                        {t("observations.batch.confirm")}
                      </Button>
                      <Button disabled={busy} onClick={() => setPreview(undefined)}>
                        {t("learnedMemory.action.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {groupCursor ? (
            <Button
              size="sm"
              disabled={loadingMore !== undefined}
              onClick={() => void loadMore("pending")}
            >
              {loadingMore === "pending"
                ? t("learnedMemory.loadingMore")
                : t("learnedMemory.loadMore")}
            </Button>
          ) : null}
        </section>
      ) : null}
      {lastBatch && canReview ? (
        <div className="review-batch-receipt">
          <span className="muted small">
            {t(
              lastBatch.decision === "merge"
                ? "observations.batch.lastMerged"
                : "observations.batch.lastRejected",
              { count: lastBatch.itemIds.length },
            )}
          </span>
          {lastBatch.decision === "reject" || lastBatch.createdEntry ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => api.undoMemoryBatch(workspaceId, lastBatch.id),
                  t("observations.batch.undone"),
                )
              }
            >
              {t("observations.batch.undo")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {topics.total > 0 && !search.trim() ? (
        <nav className="topic-tags" aria-label={t("observations.topics.label")}>
          <button
            type="button"
            className="topic-tag"
            aria-pressed={topic === undefined}
            onClick={() => setTopic(undefined)}
          >
            {t("observations.topics.all")}
          </button>
          {topics.topics.map((tag) => (
            <button
              key={tag.key}
              type="button"
              className="topic-tag"
              aria-pressed={topic === tag.key}
              onClick={() => setTopic(topic === tag.key ? undefined : tag.key)}
            >
              {t("observations.topics.tag", { label: tag.label, count: tag.count })}
            </button>
          ))}
          {topics.total > topics.topics.length ? (
            <span className="muted small">
              {t("observations.topics.more", {
                shown: topics.topics.length,
                total: topics.total,
              })}
            </span>
          ) : null}
        </nav>
      ) : null}

      {loadError ? (
        <div role="alert">
          <p className="error">{loadError}</p>
          <Button onClick={() => void reload()}>{t("observations.retry")}</Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? <output className="notice">{notice}</output> : null}

      <div className={`resource-browser${selected ? " has-detail" : ""}`}>
        <div className="resource-list-column">
          {!loaded ? (
            <p className="muted resource-status" aria-busy="true">
              {t("observations.loading")}
            </p>
          ) : loadError ? null : entries.length === 0 ? (
            <p className="muted resource-status">
              {search.trim()
                ? t("observations.noMatch", { query: search.trim() })
                : t("observations.empty")}
            </p>
          ) : (
            <ul className="resource-list" aria-label={t("observations.list.label")}>
              {entries.map((item) => {
                const state = stateText(item);
                return (
                  <li
                    key={item.id}
                    className={`resource-row${item.id === selectedId ? " selected" : ""}${item.tombstoned ? " forgotten" : ""}`}
                    data-entry={item.id}
                  >
                    <button
                      type="button"
                      className="resource-row-main"
                      disabled={busy}
                      aria-expanded={item.id === selectedId}
                      onClick={() => (item.id === selectedId ? close() : open(item.id))}
                    >
                      <span className="resource-row-title observation-body">
                        {item.tombstoned ? t("learnedMemory.body.forgotten") : item.body}
                      </span>
                      <span className="resource-row-meta">
                        {state
                          ? t("observations.metaWithState", {
                              who: who(item),
                              age: ageOf(item.observedAt, at),
                              state,
                            })
                          : t("observations.meta", {
                              who: who(item),
                              age: ageOf(item.observedAt, at),
                            })}
                      </span>
                    </button>
                    <span className="resource-row-badge">
                      {item.trust === "untrusted" && !item.tombstoned ? (
                        <Pill tone="warning" title={t("learnedMemory.pill.untrustedTitle")}>
                          {t("learnedMemory.pill.needsConfirmation")}
                        </Pill>
                      ) : null}
                    </span>
                    <ActionMenu
                      label={t("observations.moreActions", { name: snippet(item.body) })}
                      items={menuItems(item)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {entryCursor && loaded && !loadError ? (
            <Button
              size="sm"
              disabled={loadingMore !== undefined}
              onClick={() => void loadMore("entries")}
            >
              {loadingMore === "entries"
                ? t("learnedMemory.loadingMore")
                : t("learnedMemory.loadMore")}
            </Button>
          ) : null}
        </div>

        {selected ? (
          <aside className="resource-detail" aria-label={t("observations.detail.label")}>
            <header className="resource-detail-head">
              <h2>{t("observations.detail.title")}</h2>
              {!selected.tombstoned && editing?.id !== selected.id ? (
                <ActionMenu
                  className="resource-detail-menu"
                  label={t("observations.moreActions", { name: snippet(selected.body) })}
                  items={menuItems(selected).filter((item) => item.id !== "confirm")}
                />
              ) : null}
              <button
                type="button"
                className="icon-button"
                aria-label={t("observations.detail.close")}
                title={t("observations.detail.close")}
                disabled={busy}
                onClick={close}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            {editing?.id === selected.id ? (
              <div className="resource-detail-edit">
                <textarea
                  aria-label={t("learnedMemory.edit.label", { id: selected.id })}
                  value={editing.body}
                  disabled={busy}
                  onChange={(event) => setEditing({ ...editing, body: event.target.value })}
                />
                <p className="muted small">{t("learnedMemory.introRetrieval")}</p>
                <div className="resource-detail-actions">
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api.editMemoryEntry(selected.id, editing.body, editing.version);
                        setEditing(undefined);
                      }, t("learnedMemory.notice.saved"))
                    }
                  >
                    {t("learnedMemory.action.save")}
                  </Button>
                  <Button disabled={busy} onClick={() => setEditing(undefined)}>
                    {t("learnedMemory.action.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="resource-detail-body">
                {selected.tombstoned ? t("learnedMemory.body.forgotten") : selected.body}
              </p>
            )}
            {forgetting === selected.id ? (
              <div
                className="resource-confirm"
                role="alertdialog"
                aria-label={t("learnedMemory.forget.label")}
              >
                <strong>{t("learnedMemory.forget.title")}</strong>
                <p className="muted small">{t("learnedMemory.forget.body")}</p>
                <div className="resource-detail-actions">
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api.forgetMemoryEntry(selected.id);
                        setForgetting(undefined);
                      }, t("learnedMemory.notice.forgotten"))
                    }
                  >
                    {t("learnedMemory.forget.confirm")}
                  </Button>
                  <Button onClick={() => setForgetting(undefined)}>
                    {t("learnedMemory.forget.cancel")}
                  </Button>
                </div>
              </div>
            ) : null}
            <dl className="resource-facts">
              <dt>{t("observations.detail.source")}</dt>
              <dd>
                <SourceCell entry={selected} />
              </dd>
              <dt>{t("observations.detail.observed")}</dt>
              <dd>
                {t("observations.detail.observedValue", {
                  date: selected.observedAt.slice(0, 10),
                  age: ageOf(selected.observedAt, at),
                })}
              </dd>
              <dt>{t("observations.detail.validity")}</dt>
              <dd>{validityOf(selected)}</dd>
              <dt>{t("observations.detail.trust")}</dt>
              <dd>{label(TRUST_LABELS, selected.trust)}</dd>
              <dt>{t("observations.detail.kind")}</dt>
              <dd>
                {selected.kind !== "note"
                  ? t("learnedMemory.scopeWithKind", {
                      scope: label(AUTHORITY_LABELS, selected.authority),
                      kind: label(KIND_LABELS, selected.kind),
                    })
                  : label(AUTHORITY_LABELS, selected.authority)}
              </dd>
              <dt>{t("observations.detail.scope")}</dt>
              <dd>{label(SCOPE_LABELS, selected.scope)}</dd>
              <dt>{t("observations.detail.derivedFrom")}</dt>
              <dd>
                {selected.derivedFrom.length
                  ? selected.derivedFrom.join(", ")
                  : t("learnedMemory.table.directObservation")}
              </dd>
            </dl>
            {provenance?.id === selected.id ? (
              <section className="resource-versions" aria-label={t("observations.detail.history")}>
                <h3>{t("observations.detail.sources", { count: provenance.sources.length })}</h3>
                <ol>
                  {provenance.sources.map((source, n) => (
                    <li key={`${source.recordedAt}-${n}`}>
                      <span className="muted small">
                        {t("observations.detail.sourceRow", {
                          date: source.effectiveAt.slice(0, 10),
                          kind: label(SOURCE_KIND_LABELS, source.sourceKind),
                          trust: label(TRUST_LABELS, source.trust),
                        })}
                      </span>{" "}
                      {source.sourceRunId ? (
                        <a href={runHref(source.sourceRunId)}>{source.sourceRunId}</a>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {provenance.supersessions.length > 0 ? (
                  <>
                    <h3>{t("observations.detail.history")}</h3>
                    <ul>
                      {provenance.supersessions.map((receipt) => (
                        <li key={receipt.id} className="muted small">
                          {t(
                            receipt.entryId === selected.id
                              ? "observations.detail.replacedBy"
                              : "observations.detail.replaced",
                            {
                              date: receipt.createdAt.slice(0, 10),
                              reason: label(SUPERSESSION_LABELS, receipt.reason),
                            },
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
            ) : null}
            {!selected.tombstoned &&
            editing?.id !== selected.id &&
            selected.trust === "untrusted" ? (
              <div className="resource-detail-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => api.confirmMemoryEntry(selected.id),
                      t("learnedMemory.notice.confirmed"),
                    )
                  }
                >
                  {t("learnedMemory.action.confirm")}
                </Button>
              </div>
            ) : null}
            {loadingVersions ? <output>{t("learnedMemory.loadingMore")}</output> : null}
            {versions?.id === selected.id ? (
              <section className="resource-versions" aria-label={t("learnedMemory.versions.label")}>
                <h3>{t("observations.detail.versions")}</h3>
                <ol>
                  {versions.items.map((version) => (
                    <li key={version.version}>
                      <span className="muted small">
                        {t("observations.detail.versionMeta", {
                          version: version.version,
                          op: label(OP_LABELS, version.op),
                          date: version.createdAt.slice(0, 10),
                        })}
                      </span>
                      <span>
                        {version.redacted ? t("learnedMemory.versions.redacted") : version.body}
                      </span>
                    </li>
                  ))}
                </ol>
                {versions.nextCursor ? (
                  <Button
                    size="sm"
                    disabled={loadingVersions}
                    onClick={() => showVersions(versions.id, versions.nextCursor)}
                  >
                    {t("learnedMemory.versions.loadOlder")}
                  </Button>
                ) : null}
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
