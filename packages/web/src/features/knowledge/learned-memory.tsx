import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@deskmates/ui";
import { Select } from "@deskmates/ui";
// "Learned memory" (ADR-0011): what the bots of a workspace learned, per workspace and per bot,
// with scope, trust, authority, source and age. The operator supervises quality (edit, forget,
// undo, confirm); only gated items ask for a decision, under "Needs your confirmation".

import type {
  BotDefinition,
  BotId,
  ConfirmationReason,
  MemoryAuthority,
  MemoryConfirmation,
  MemoryEntryKind,
  MemoryScope,
  MemorySourceKind,
  MemorySupersessionReason,
  MemoryTrust,
  MemoryVersion,
  MemoryVersionOp,
  Thread,
  ThreadId,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, LearnedMemoryEntry } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Pill } from "../../components/ui/pill.js";
import type { MessageKey } from "../../i18n/catalogs.js";
import { useT } from "../../i18n/i18n-provider.js";
import { currentI18n } from "../../i18n/intl.js";
import { runHref } from "../../router.js";
import { RoleNote, useCan } from "../../state/session-roles.js";

export type LearnedMemoryApi = Pick<
  ApiClient,
  | "listWorkspaces"
  | "listBots"
  | "listMemoryEntriesPage"
  | "editMemoryEntry"
  | "forgetMemoryEntry"
  | "undoMemoryEntry"
  | "confirmMemoryEntry"
  | "listMemorySuggestions"
  | "reviewMemorySuggestion"
  | "listMemoryVersionsPage"
  | "listThreads"
  | "closeThreadTask"
  | "consolidateBotMemory"
  | "searchLearnedMemoryPage"
  | "memoryIndexObservation"
>;

type Tab = { kind: "workspace" } | { kind: "bot"; botId: BotId };

export const REASON_LABELS: Readonly<Record<ConfirmationReason, MessageKey>> = {
  imperative: "learnedMemory.reason.imperative",
  duty_change: "learnedMemory.reason.dutyChange",
  contradicts_rule: "learnedMemory.reason.contradictsRule",
  contradicts_trusted: "learnedMemory.reason.contradictsTrusted",
  untrusted_sources: "learnedMemory.reason.untrustedSources",
};

/** Gated items per request; further pages load on "Load more" (ADR-0011 A15). */
export const PENDING_PAGE = 50;

/** Append a page, leaving out ids already shown (a row may move between pages). */
export function appendNew<T extends { id: string }>(
  current: readonly T[],
  page: readonly T[],
): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !seen.has(item.id))];
}

/** Why a value stopped being current (ADR-0011 amendment 2); shown in the entry's history. */
export const SUPERSESSION_LABELS: Readonly<Record<MemorySupersessionReason, MessageKey>> = {
  backfill: "learnedMemory.supersession.backfill",
  equivalent_higher_trust: "learnedMemory.supersession.equivalentHigherTrust",
  equivalent_lower_trust: "learnedMemory.supersession.equivalentLowerTrust",
  newer_effective_time: "learnedMemory.supersession.newerEffectiveTime",
  older_arrival: "learnedMemory.supersession.olderArrival",
  tie_entry_id: "learnedMemory.supersession.tieEntryId",
  tie_later_ingestion: "learnedMemory.supersession.tieLaterIngestion",
  undo_restore: "learnedMemory.supersession.undoRestore",
};

export const SOURCE_KIND_LABELS: Readonly<Record<MemorySourceKind, MessageKey>> = {
  human: "learnedMemory.sourceKind.human",
  bot_self: "learnedMemory.sourceKind.botSelf",
  other_bot: "learnedMemory.sourceKind.otherBot",
  tool: "learnedMemory.sourceKind.tool",
  page: "learnedMemory.sourceKind.page",
  webhook: "learnedMemory.sourceKind.webhook",
};

export const SCOPE_LABELS: Readonly<Record<MemoryScope, MessageKey>> = {
  task: "learnedMemory.scope.task",
  workspace: "learnedMemory.scope.workspace",
  bot: "learnedMemory.scope.bot",
  rule: "learnedMemory.scope.rule",
};

export const TRUST_LABELS: Readonly<Record<MemoryTrust, MessageKey>> = {
  trusted: "learnedMemory.trust.trusted",
  untrusted: "learnedMemory.trust.untrusted",
};

export const AUTHORITY_LABELS: Readonly<Record<MemoryAuthority, MessageKey>> = {
  fact: "learnedMemory.authority.fact",
  preference: "learnedMemory.authority.preference",
  procedure: "learnedMemory.authority.procedure",
};

export const KIND_LABELS: Readonly<Record<MemoryEntryKind, MessageKey>> = {
  note: "learnedMemory.kind.note",
  candidate: "learnedMemory.kind.candidate",
  episode: "learnedMemory.kind.episode",
};

export const OP_LABELS: Readonly<Record<MemoryVersionOp, MessageKey>> = {
  create: "learnedMemory.op.create",
  edit: "learnedMemory.op.edit",
  forget: "learnedMemory.op.forget",
  undo: "learnedMemory.op.undo",
  confirm: "learnedMemory.op.confirm",
  supersede: "learnedMemory.op.supersede",
  consolidate: "learnedMemory.op.consolidate",
};

/** A known code's words, else the code itself (a newer Gateway may send one this UI lacks). */
export function label<K extends string>(table: Readonly<Record<K, MessageKey>>, code: K): string {
  const key = table[code] as MessageKey | undefined;
  return key ? currentI18n().t(key) : code.replaceAll("_", " ");
}

export function ageOf(iso: string, now: Date): string {
  const { t } = currentI18n();
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return t("learnedMemory.age.justNow");
  if (seconds < 3600) return t("learnedMemory.age.minutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("learnedMemory.age.hours", { count: Math.floor(seconds / 3600) });
  return t("learnedMemory.age.days", { count: Math.floor(seconds / 86400) });
}

export function validityOf(entry: LearnedMemoryEntry): string {
  const { t } = currentI18n();
  if (entry.tombstoned) return t("learnedMemory.validity.forgotten");
  if (entry.supersededBy)
    return entry.invalidAt
      ? t("learnedMemory.validity.supersededOn", { date: entry.invalidAt.slice(0, 10) })
      : t("learnedMemory.validity.superseded");
  if (entry.episodeId) return t("learnedMemory.validity.episode");
  if (!entry.live) return t("learnedMemory.validity.expired");
  return t("learnedMemory.validity.validSince", { date: entry.validFrom.slice(0, 10) });
}

export function SourceCell({ entry }: { entry: LearnedMemoryEntry }) {
  const t = useT();
  const who =
    entry.sourceKind === "human"
      ? t("learnedMemory.source.human")
      : t("learnedMemory.source.learnedBy", {
          bot: entry.learnedBy ?? t("learnedMemory.source.aBot"),
        });
  const runId = entry.sourceRunId;
  const source = runId
    ? t.rich("learnedMemory.source.fromRun", {
        who,
        runId,
        link: (chunks) => <a href={runHref(runId)}>{chunks}</a>,
      })
    : who;
  return (
    <span>
      {entry.sourceKind !== "human" && entry.sourceKind !== "bot_self"
        ? t.rich("learnedMemory.source.afterReading", {
            source,
            kind: label(SOURCE_KIND_LABELS, entry.sourceKind),
          })
        : source}
    </span>
  );
}

export interface LearnedMemoryProps {
  api: LearnedMemoryApi;
  now?: () => Date;
  /**
   * Embedded on a profile, a chat or the workspace page: the owner is fixed by the caller, the
   * page chrome (title, workspace picker, owner tabs) is left out, and only the entries of that
   * owner are shown.
   */
  embedded?: boolean;
  workspaceId?: WorkspaceId;
  owner?: Tab;
  /** Only the task notes of this chat (task scope entries written in it). */
  threadId?: ThreadId;
  /** Show the "needs your confirmation" queue (the workspace page does; a chat does not). */
  showConfirmations?: boolean;
}

export function LearnedMemoryScreen({
  api,
  now = () => new Date(),
  embedded = false,
  workspaceId: fixedWorkspaceId,
  owner,
  threadId: fixedThreadId,
  showConfirmations = !embedded,
}: LearnedMemoryProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId | undefined>(fixedWorkspaceId);
  const [bots, setBots] = useState<BotDefinition[]>([]);
  const [tab, setTab] = useState<Tab>(owner ?? { kind: "workspace" });
  const [entries, setEntries] = useState<LearnedMemoryEntry[]>([]);
  const [pending, setPending] = useState<MemoryConfirmation[]>([]);
  const [editing, setEditing] = useState<{ id: string; body: string; version: number }>();
  const [forgetting, setForgetting] = useState<string>();
  const [versions, setVersions] = useState<{
    id: string;
    items: MemoryVersion[];
    nextCursor?: string | undefined;
  }>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [search, setSearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [indexObservation, setIndexObservation] = useState<{
    runId: string;
    counts: {
      considered: number;
      pinned: number;
      untrusted: number;
      budget: number;
      ineligible: number;
    };
  }>();
  const [pendingCursor, setPendingCursor] = useState<string>();
  const [entryCursor, setEntryCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState<"pending" | "entries">();
  const reloadSeq = useRef(0);
  const t = useT();
  // Memory curation is configuration: Admins curate, Members read (ADR-0022 amendment 1, C2).
  const canCurate = useCan("memory.editEntry").allowed;

  useEffect(() => {
    if (fixedWorkspaceId) {
      setWorkspaceId(fixedWorkspaceId);
      return;
    }
    let active = true;
    api
      .listWorkspaces()
      .then((list) => {
        if (!active) return;
        setWorkspaces(list);
        setWorkspaceId((current) => current ?? list[0]?.id);
      })
      .catch((err: Error) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [api, fixedWorkspaceId]);

  const visible = useCallback(
    (list: readonly LearnedMemoryEntry[]) =>
      list.filter(
        (entry) =>
          (showHistory || entry.live) &&
          (tab.kind === "bot" ? entry.botId === tab.botId : entry.scope !== "bot") &&
          (fixedThreadId === undefined || entry.threadId === fixedThreadId),
      ),
    [tab, showHistory, fixedThreadId],
  );

  /** The list's server-side filters: a bot's experience, or one chat's task notes. */
  const entryFilters = useCallback(
    () => ({
      ...(tab.kind === "bot" ? { botId: tab.botId, scope: "bot" as const } : {}),
      ...(fixedThreadId !== undefined ? { threadId: fixedThreadId, scope: "task" as const } : {}),
      includeForgotten: showHistory,
    }),
    [tab, fixedThreadId, showHistory],
  );

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    const seq = ++reloadSeq.current;
    const [nextEntries, nextPending] = await Promise.all([
      search.trim()
        ? api.searchLearnedMemoryPage(workspaceId, search.trim(), {
            ...(tab.kind === "bot" ? { scope: "bot" as const } : {}),
          })
        : api.listMemoryEntriesPage(workspaceId, entryFilters()),
      api.listMemorySuggestions({ workspaceId, status: "pending", limit: PENDING_PAGE }),
    ]);
    if (seq !== reloadSeq.current) return;
    setEntries(visible(nextEntries.entries));
    setEntryCursor(nextEntries.nextCursor);
    setPending(nextPending.suggestions);
    setPendingCursor(nextPending.nextCursor);
  }, [api, workspaceId, tab, search, visible, entryFilters]);

  // ADR-0011 A15: later pages are loaded on request and appended; nothing is dropped silently.
  const loadMore = async (which: "pending" | "entries") => {
    if (!workspaceId) return;
    const seq = reloadSeq.current;
    setLoadingMore(which);
    try {
      if (which === "pending" && pendingCursor) {
        const page = await api.listMemorySuggestions({
          workspaceId,
          status: "pending",
          limit: PENDING_PAGE,
          cursor: pendingCursor,
        });
        if (seq !== reloadSeq.current) return;
        setPending((current) => appendNew(current, page.suggestions));
        setPendingCursor(page.nextCursor);
      } else if (which === "entries" && entryCursor) {
        // #113 K2: the list and the search each page with their own cursor.
        const page = search.trim()
          ? await api.searchLearnedMemoryPage(workspaceId, search.trim(), {
              ...(tab.kind === "bot" ? { scope: "bot" as const } : {}),
              cursor: entryCursor,
            })
          : await api.listMemoryEntriesPage(workspaceId, {
              ...entryFilters(),
              cursor: entryCursor,
            });
        if (seq !== reloadSeq.current) return;
        setEntries((current) => appendNew(current, visible(page.entries)));
        setEntryCursor(page.nextCursor);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(undefined);
    }
  };

  const loadMoreButton = (which: "pending" | "entries") => (
    <Button type="button" disabled={loadingMore !== undefined} onClick={() => void loadMore(which)}>
      {loadingMore === which ? t("learnedMemory.loadingMore") : t("learnedMemory.loadMore")}
    </Button>
  );

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    api
      .listBots(workspaceId)
      .then(async (list) => {
        if (!active) return;
        setBots(list);
        const ids = new Set(list.map((bot) => bot.id));
        // #113 slice R: the newest observation comes from a per-workspace summary.
        const observation = ids.size > 0 ? await api.memoryIndexObservation(workspaceId) : null;
        if (!active) return;
        const counts = observation?.counts;
        if (observation && counts && "considered" in counts)
          setIndexObservation({
            runId: observation.runId,
            counts: counts as {
              considered: number;
              pinned: number;
              untrusted: number;
              budget: number;
              ineligible: number;
            },
          });
        else setIndexObservation(undefined);
      })
      .catch((err: Error) => active && setError(err.message));
    api
      .listThreads(workspaceId)
      .then((list) => active && setThreads(list))
      .catch((err: Error) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [api, workspaceId]);

  useEffect(() => {
    reload().catch((err: Error) => setError(err.message));
    return () => {
      reloadSeq.current += 1;
    };
  }, [reload]);

  const perform = async (operation: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await reload();
      setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const botName = (id: BotId) => bots.find((bot) => bot.id === id)?.name ?? id;
  const at = now();

  const emptyText =
    fixedThreadId !== undefined
      ? t("learnedMemory.empty.taskNotes")
      : owner?.kind === "bot"
        ? t("learnedMemory.empty.experience")
        : t("learnedMemory.empty.facts");

  const bodyFor = (entry: LearnedMemoryEntry) =>
    editing?.id === entry.id ? (
      <textarea
        aria-label={t("learnedMemory.edit.label", { id: entry.id })}
        value={editing.body}
        onChange={(event) => setEditing({ ...editing, id: entry.id, body: event.target.value })}
      />
    ) : (
      <span>{entry.tombstoned ? t("learnedMemory.body.forgotten") : entry.body}</span>
    );

  const actionsFor = (entry: LearnedMemoryEntry) => (
    <>
      {entry.tombstoned ? null : editing?.id === entry.id ? (
        <>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api.editMemoryEntry(entry.id, editing.body, editing.version);
                setEditing(undefined);
              }, t("learnedMemory.notice.saved"))
            }
          >
            {t("learnedMemory.action.save")}
          </Button>
          <Button type="button" onClick={() => setEditing(undefined)}>
            {t("learnedMemory.action.cancel")}
          </Button>
        </>
      ) : (
        <>
          {canCurate ? (
            <>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  setEditing({ id: entry.id, body: entry.body, version: entry.version })
                }
              >
                {t("learnedMemory.action.edit")}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setForgetting(entry.id)}>
                {t("learnedMemory.action.forget")}
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void api
                .listMemoryVersionsPage(entry.id)
                .then((page) =>
                  setVersions({ id: entry.id, items: page.versions, nextCursor: page.nextCursor }),
                )
                .catch((err: Error) => setError(err.message))
            }
          >
            {t("learnedMemory.action.versions")}
          </Button>
          {canCurate && entry.version > 1 ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(() => api.undoMemoryEntry(entry.id), t("learnedMemory.notice.undone"))
              }
            >
              {t("learnedMemory.action.undo")}
            </Button>
          ) : null}
          {canCurate && entry.trust === "untrusted" ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => api.confirmMemoryEntry(entry.id),
                  t("learnedMemory.notice.confirmed"),
                )
              }
            >
              {t("learnedMemory.action.confirm")}
            </Button>
          ) : null}
        </>
      )}
    </>
  );

  return (
    <section className={embedded ? "learned-memory embedded" : "learned-memory"}>
      {embedded ? null : (
        <>
          <h1>{t("learnedMemory.title")}</h1>
          <p>{t("learnedMemory.intro")}</p>
          <p>{t("learnedMemory.introRetrieval")}</p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      {embedded ? null : (
        <Select
          label={t("learnedMemory.workspace")}
          value={workspaceId ?? ""}
          onValueChange={(value) => {
            reloadSeq.current += 1;
            setEntries([]);
            setPending([]);
            setThreads([]);
            setThreadId("");
            setEditing(undefined);
            setForgetting(undefined);
            setVersions(undefined);
            setIndexObservation(undefined);
            setNotice("");
            setWorkspaceId(value as WorkspaceId);
            setTab({ kind: "workspace" });
          }}
          disabled={busy}
          options={[
            ...workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            })),
          ]}
        />
      )}
      {indexObservation && !embedded ? (
        <p>
          {t.rich("learnedMemory.index", {
            pinned: indexObservation.counts.pinned,
            considered: indexObservation.counts.considered,
            untrusted: indexObservation.counts.untrusted,
            budget: indexObservation.counts.budget,
            ineligible: indexObservation.counts.ineligible,
            link: (chunks) => <a href={runHref(indexObservation.runId)}>{chunks}</a>,
          })}
        </p>
      ) : null}
      <section
        aria-label={t("learnedMemory.actions.label")}
        className={embedded ? "memory-toolbar" : undefined}
      >
        <label className={embedded ? "memory-search" : undefined}>
          {embedded ? (
            <Search size={15} aria-hidden="true" />
          ) : (
            <>{t("learnedMemory.search.label")} </>
          )}
          <input
            type={embedded ? "search" : "text"}
            aria-label={t("learnedMemory.search.label")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              embedded
                ? owner?.kind === "bot"
                  ? t("learnedMemory.search.experience")
                  : fixedThreadId !== undefined
                    ? t("learnedMemory.search.taskNotes")
                    : t("learnedMemory.search.facts")
                : t("learnedMemory.search.all")
            }
          />
        </label>
        {search.trim() && showHistory ? (
          <p className="muted small">{t("learnedMemory.search.activeOnly")}</p>
        ) : null}
        <label className={embedded ? "memory-toggle" : undefined}>
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(event) => setShowHistory(event.target.checked)}
          />
          {t("learnedMemory.showHistory")}
        </label>
        {fixedThreadId === undefined && !embedded ? (
          <Select
            label={t("learnedMemory.finish.label")}
            value={threadId}
            disabled={busy}
            onValueChange={(value) => setThreadId(value)}
            options={[
              {
                value: "",
                label: t("learnedMemory.finish.choose"),
              },
              ...threads

                .filter((thread) => thread.workspaceId === workspaceId)
                .map((thread) => ({
                  value: thread.id,
                  label: thread.title,
                })),
            ]}
          />
        ) : null}
        {canCurate && (fixedThreadId !== undefined || !embedded) ? (
          <Button
            type="button"
            disabled={busy || !(fixedThreadId ?? threadId)}
            onClick={() =>
              void perform(
                () => api.closeThreadTask((fixedThreadId ?? threadId) as Thread["id"]),
                t("learnedMemory.notice.finished"),
              )
            }
          >
            {t("learnedMemory.finish.button")}
          </Button>
        ) : null}
        {fixedThreadId === undefined && !embedded ? (
          <p>{t("learnedMemory.finish.explain")}</p>
        ) : null}
        {canCurate && tab.kind === "bot" ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(
                () => api.consolidateBotMemory(tab.botId),
                t("learnedMemory.notice.consolidationQueued"),
              )
            }
          >
            {t("learnedMemory.consolidate")}
          </Button>
        ) : null}
        <RoleNote action="memory.editEntry" does={t("learnedMemory.roleNote")} />
      </section>

      {showConfirmations ? (
        <section aria-label={t("learnedMemory.confirmations.label")}>
          <h2>{t("learnedMemory.confirmations.title")}</h2>
          {pending.length === 0 ? <p>{t("learnedMemory.confirmations.empty")}</p> : null}
          {pendingCursor ? (
            <p className="muted small">
              {t("learnedMemory.confirmations.partial", { count: pending.length })}
            </p>
          ) : null}
          {pending.map((item) => (
            <article key={item.id} className="memory-confirmation">
              <p>{item.body}</p>
              <p>
                {t("learnedMemory.confirmations.meta", {
                  scope: label(SCOPE_LABELS, item.proposedScope),
                  trust: label(TRUST_LABELS, item.trust),
                  bot: botName(item.botId),
                  reasons:
                    item.reasons.length > 0
                      ? item.reasons.map((reason) => label(REASON_LABELS, reason)).join("; ")
                      : t("learnedMemory.confirmations.legacy"),
                })}
              </p>
              <a href={runHref(item.runId)}>{t("learnedMemory.confirmations.sourceRun")}</a>
              {canCurate ? (
                <>
                  <Button
                    type="button"
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
                    type="button"
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
                </>
              ) : null}
            </article>
          ))}
          {pendingCursor ? loadMoreButton("pending") : null}
        </section>
      ) : null}

      {owner ? null : (
        <div role="tablist" aria-label={t("learnedMemory.owner.label")}>
          <Button
            type="button"
            role="tab"
            aria-selected={tab.kind === "workspace"}
            disabled={busy}
            onClick={() => setTab({ kind: "workspace" })}
          >
            {t("learnedMemory.owner.workspace")}
          </Button>
          {bots.map((bot) => (
            <Button
              key={bot.id}
              type="button"
              role="tab"
              aria-selected={tab.kind === "bot" && tab.botId === bot.id}
              disabled={busy}
              onClick={() => setTab({ kind: "bot", botId: bot.id })}
            >
              {bot.name}
            </Button>
          ))}
        </div>
      )}

      {embedded ? (
        <ul className="memory-cards" aria-label={t("learnedMemory.entries.label")}>
          {entries.length === 0 ? (
            <li className="memory-card empty muted small">{emptyText}</li>
          ) : null}
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={`memory-card${entry.tombstoned ? " forgotten" : ""}`}
              data-entry={entry.id}
            >
              <div className="memory-card-body">{bodyFor(entry)}</div>
              <div className="memory-card-meta">
                <Pill tone="neutral" title={t("learnedMemory.pill.authorityTitle")}>
                  {label(AUTHORITY_LABELS, entry.authority)}
                </Pill>
                {entry.kind !== "note" ? (
                  <Pill tone="neutral">{label(KIND_LABELS, entry.kind)}</Pill>
                ) : null}
                {entry.trust === "untrusted" ? (
                  <Pill tone="warning" title={t("learnedMemory.pill.untrustedTitle")}>
                    {t("learnedMemory.pill.needsConfirmation")}
                  </Pill>
                ) : null}
                <span className="muted small">
                  <SourceCell entry={entry} /> · {ageOf(entry.observedAt, at)} · {validityOf(entry)}
                </span>
              </div>
              <div className="memory-card-actions">{actionsFor(entry)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <Table aria-label={t("learnedMemory.entries.label")} className="memory-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("learnedMemory.table.memory")}</TableHead>
              <TableHead>{t("learnedMemory.table.scope")}</TableHead>
              <TableHead>{t("learnedMemory.table.trust")}</TableHead>
              <TableHead>{t("learnedMemory.table.authority")}</TableHead>
              <TableHead>{t("learnedMemory.table.source")}</TableHead>
              <TableHead>{t("learnedMemory.table.age")}</TableHead>
              <TableHead>{t("learnedMemory.table.derivedFrom")}</TableHead>
              <TableHead>{t("learnedMemory.table.validity")}</TableHead>
              <TableHead>{t("learnedMemory.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="table-empty">
                  {t("learnedMemory.table.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {entries.map((entry) => (
              <TableRow key={entry.id} data-entry={entry.id}>
                <TableCell>{bodyFor(entry)}</TableCell>
                <TableCell>
                  {entry.kind !== "note"
                    ? t("learnedMemory.scopeWithKind", {
                        scope: label(SCOPE_LABELS, entry.scope),
                        kind: label(KIND_LABELS, entry.kind),
                      })
                    : label(SCOPE_LABELS, entry.scope)}
                </TableCell>
                <TableCell>{label(TRUST_LABELS, entry.trust)}</TableCell>
                <TableCell>{label(AUTHORITY_LABELS, entry.authority)}</TableCell>
                <TableCell>
                  <SourceCell entry={entry} />
                </TableCell>
                <TableCell>{ageOf(entry.observedAt, at)}</TableCell>
                <TableCell>
                  {entry.derivedFrom.length
                    ? entry.derivedFrom.join(", ")
                    : t("learnedMemory.table.directObservation")}
                </TableCell>
                <TableCell>{validityOf(entry)}</TableCell>
                <TableCell>{actionsFor(entry)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {entryCursor ? loadMoreButton("entries") : null}
      {versions ? (
        <section aria-label={t("learnedMemory.versions.label")}>
          <h2>{t("learnedMemory.versions.title", { id: versions.id })}</h2>
          {versions.items.map((version) => (
            <p key={version.version}>
              {t("learnedMemory.versions.row", {
                version: version.version,
                op: label(OP_LABELS, version.op),
                createdAt: version.createdAt,
                body: version.redacted ? t("learnedMemory.versions.redacted") : version.body,
              })}
            </p>
          ))}
          {versions.nextCursor ? (
            <Button
              type="button"
              onClick={() => {
                const { id, nextCursor } = versions;
                void api
                  .listMemoryVersionsPage(id, nextCursor ? { cursor: nextCursor } : {})
                  .then((page) =>
                    setVersions((current) =>
                      current?.id === id
                        ? {
                            id,
                            items: [
                              ...current.items,
                              ...page.versions.filter(
                                (v) => !current.items.some((c) => c.version === v.version),
                              ),
                            ],
                            nextCursor: page.nextCursor,
                          }
                        : current,
                    ),
                  )
                  .catch((err: Error) => setError(err.message));
              }}
            >
              {t("learnedMemory.versions.loadOlder")}
            </Button>
          ) : null}
          <Button type="button" onClick={() => setVersions(undefined)}>
            {t("learnedMemory.versions.close")}
          </Button>
        </section>
      ) : null}
      {forgetting ? (
        <dialog open aria-label={t("learnedMemory.forget.label")}>
          <h2>{t("learnedMemory.forget.title")}</h2>
          <p>{t("learnedMemory.forget.body")}</p>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api.forgetMemoryEntry(forgetting);
                setForgetting(undefined);
              }, t("learnedMemory.notice.forgotten"))
            }
          >
            {t("learnedMemory.forget.confirm")}
          </Button>
          <Button type="button" onClick={() => setForgetting(undefined)}>
            {t("learnedMemory.forget.cancel")}
          </Button>
        </dialog>
      ) : null}
    </section>
  );
}
