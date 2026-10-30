// Approval inbox (M1): every pending approval in the deployment, across threads and bots.
//
// The inbox is a convenience, not a second authority: a row here is the same approval the thread
// shows inline, decided the same way (ADR-0002 amendment 2 — any member may decide). A row leaves
// the list as soon as it is decided, whoever decided it, because the `approval` frame the Gateway
// fans out on a decision carries the settled approval.

import type { Approval } from "@deskmates/contracts";
import { Button, EmptyState, PageHeader, Pager } from "@deskmates/ui";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { ApiError } from "../../api/types.js";
import { errorMessage, formatDuration } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { usePageRangeText } from "../../lib/page-bar.js";
import { threadHref } from "../../router.js";
import { newerApproval } from "../../state/newer-approval.js";
import { NextAction, useCan } from "../../state/session-roles.js";
import { useBotLookup } from "../contacts/use-bots-by-ids.js";
import type { PendingApprovalGroup } from "./api.js";
import { ApprovalCard } from "./approval-card.js";

export interface ApprovalsScreenProps {
  api?: ApiClient;
}

/** The inbox page size; the Gateway's default for the pending queue (#113 surface 23). */
export const PENDING_PAGE_SIZE = 25;
/** How long a burst of approval frames is gathered before a multi-page view refetches. */
const MULTI_PAGE_REFETCH_MS = 250;

function usePendingApprovalGroups(
  api: ApiClient,
  cursor?: string,
): {
  groups: PendingApprovalGroup[];
  loaded: boolean;
  error: string | undefined;
  totalGroups: number;
  totalApprovals: number;
  nextCursor?: string;
  replace: (approval: Approval) => void;
  reload: () => void;
} {
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<{
    groups: PendingApprovalGroup[];
    totalGroups: number;
    totalApprovals: number;
    nextCursor?: string;
  }>({ groups: [], totalGroups: 0, totalApprovals: 0 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const eventRevision = useRef(0);
  const eventArrivalRevision = useRef(new Map<string, number>());
  const pageHasMore = useRef(false);
  const legacyGateway = useRef(false);
  const reload = () => setRevision((value) => value + 1);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const replace = useRef((approval: Approval) => {
    setPage((current) => {
      const index = current.groups.findIndex((group) => group.approval.id === approval.id);
      if (approval.decision !== undefined) {
        if (index < 0) return current;
        const group = current.groups[index];
        if (!group) return current;
        return {
          ...current,
          groups:
            group.count === 1
              ? current.groups.filter((_, at) => at !== index)
              : current.groups.map((item, at) =>
                  at === index ? { ...item, count: item.count - 1 } : item,
                ),
          totalGroups: current.totalGroups - (group.count === 1 ? 1 : 0),
          totalApprovals: Math.max(0, current.totalApprovals - 1),
        };
      }
      if (index >= 0)
        return {
          ...current,
          groups: current.groups.map((group, at) =>
            at === index ? { ...group, approval } : group,
          ),
        };
      if (cursorRef.current || current.nextCursor) return current;
      return {
        ...current,
        groups: [...current.groups, { key: approval.id, approval, count: 1 }].sort((a, b) =>
          a.approval.createdAt.localeCompare(b.approval.createdAt),
        ),
        totalGroups: current.totalGroups + 1,
        totalApprovals: current.totalApprovals + 1,
      };
    });
  }).current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a queue refetch.
  useEffect(() => {
    let cancelled = false;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => {
      const requestId = ++requestSequence;
      const request = cursor ? { cursor } : {};
      const eventRevisionAtStart = eventRevision.current;
      api
        .listPendingApprovalGroupsPage(request)
        // During a rolling upgrade an older Gateway has only the per-request inbox. Keep the
        // page usable, without pretending its rows are grouped; the new Gateway remains the
        // grouping authority and supplies stable group keys.
        .catch(async (err: unknown) => {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          legacyGateway.current = true;
          const legacy = await api.listPendingApprovalsPage(request);
          return {
            groups: legacy.approvals.map((approval) => ({
              key: approval.id,
              approval,
              count: 1,
            })),
            totalGroups: legacy.total ?? legacy.approvals.length,
            totalApprovals: legacy.total ?? legacy.approvals.length,
            ...(legacy.nextCursor ? { nextCursor: legacy.nextCursor } : {}),
          };
        })
        .then((next) => {
          if (cancelled || requestId !== requestSequence) return;
          pageHasMore.current = next.nextCursor !== undefined;
          setPage((current) => {
            if (eventRevision.current === eventRevisionAtStart) return next;
            const ids = new Set(next.groups.map((group) => group.approval.id));
            const arrived = current.groups.filter(
              (group) =>
                !ids.has(group.approval.id) &&
                group.approval.decision === undefined &&
                (eventArrivalRevision.current.get(group.approval.id) ?? 0) > eventRevisionAtStart,
            );
            return arrived.length === 0
              ? next
              : {
                  ...next,
                  groups: [...next.groups, ...arrived].sort((a, b) =>
                    a.approval.createdAt.localeCompare(b.approval.createdAt),
                  ),
                  totalGroups: next.totalGroups + arrived.length,
                  totalApprovals:
                    next.totalApprovals + arrived.reduce((count, group) => count + group.count, 0),
                };
          });
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (!cancelled && requestId === requestSequence) setError(errorMessage(err));
        })
        .finally(() => {
          if (!cancelled && requestId === requestSequence) setLoaded(true);
        });
    };
    setLoaded(false);
    const stop = globalThis.EventSource
      ? subscribeEvents({
          onEvent: (event) => {
            if (event.type !== "approval") return;
            eventRevision.current += 1;
            eventArrivalRevision.current.set(event.approval.id, eventRevision.current);
            replace(event.approval);
            if (legacyGateway.current && !pageHasMore.current) return;
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(refetch, MULTI_PAGE_REFETCH_MS);
          },
          onReconnect: refetch,
        })
      : () => {};
    refetch();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop();
    };
  }, [api, cursor, revision, replace]);

  return { ...page, loaded, error, replace, reload };
}

/**
 * One page of pending approvals, seeded by a fetch and kept current by the global `approval`
 * stream. Exported so the top bar can badge the nav link with the server's `total`.
 *
 * While every pending approval fits on the page, frames are merged in place and the total is
 * exact. With more pages, a frame never shifts the page: a burst of frames refetches the page
 * shown, and the total comes from that answer.
 */
export function usePendingApprovals(
  api: ApiClient,
  onConnectionTrouble?: () => void,
  cursor?: string,
): {
  approvals: Approval[];
  loaded: boolean;
  error: string | undefined;
  replace: (approval: Approval) => void;
  total: number;
  nextCursor: string | undefined;
} {
  const [byId, setById] = useState<Readonly<Record<string, Approval>>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [server, setServer] = useState<{
    total: number | undefined;
    nextCursor: string | undefined;
    ids: ReadonlySet<string>;
  }>({ total: undefined, nextCursor: undefined, ids: new Set() });
  const eventRevision = useRef(0);
  const approvalRevision = useRef<Readonly<Record<string, number>>>({});
  const fetchRevision = useRef(0);
  const multiPage = useRef(false);
  multiPage.current = server.nextCursor !== undefined || cursor !== undefined;

  const upsert = useRef((incoming: Approval) => {
    eventRevision.current += 1;
    approvalRevision.current = {
      ...approvalRevision.current,
      [incoming.id]: eventRevision.current,
    };
    setById((prev) => ({ ...prev, [incoming.id]: newerApproval(prev[incoming.id], incoming) }));
  }).current;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Another page: nothing of the previous one stays, and it counts as loading until answered.
    setById({});
    setLoaded(false);
    const refetch = (): void => {
      const requestRevision = ++fetchRevision.current;
      const eventRevisionAtStart = eventRevision.current;
      api
        .listPendingApprovalsPage(cursor ? { cursor } : {})
        .then((page) => {
          if (cancelled || requestRevision !== fetchRevision.current) return;
          const list = page.approvals;
          setServer({
            total: page.total,
            nextCursor: page.nextCursor,
            ids: new Set(list.map((approval) => approval.id)),
          });
          setById((prev) => {
            const next = { ...prev };
            const pendingIds = new Set(list.map((approval) => approval.id));
            // A pending-only snapshot is authoritative for records that existed when its request
            // began. Preserve records delivered by SSE afterwards: the snapshot cannot know
            // about those, and deleting them would trade a ghost for a missed live approval.
            for (const [id, existing] of Object.entries(next)) {
              if (
                existing.decision === undefined &&
                !pendingIds.has(existing.id) &&
                (approvalRevision.current[id] ?? 0) <= eventRevisionAtStart
              ) {
                delete next[id];
              }
            }
            for (const approval of list) {
              next[approval.id] = newerApproval(next[approval.id], approval);
            }
            return next;
          });
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };

    const stop = globalThis.EventSource
      ? subscribeEvents({
          onEvent: (event) => {
            if (cancelled || event.type !== "approval") return;
            if (!multiPage.current) {
              upsert(event.approval);
              return;
            }
            // More than one page: a row on this page changes in place, nothing is inserted,
            // and the page and its total are asked for again once the burst is over.
            setById((prev) =>
              prev[event.approval.id]
                ? {
                    ...prev,
                    [event.approval.id]: newerApproval(prev[event.approval.id], event.approval),
                  }
                : prev,
            );
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(refetch, MULTI_PAGE_REFETCH_MS);
          },
          onStatus: (status) => {
            if (!cancelled && status === "reconnecting") onConnectionTrouble?.();
          },
          // Frames emitted while the stream was down are gone; ask again for the whole list.
          onReconnect: refetch,
        })
      : () => {};
    refetch();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop();
    };
  }, [api, onConnectionTrouble, upsert, cursor]);

  const approvals = Object.values(byId)
    .filter((a) => a.decision === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // The server's total, moved by what the stream has said since: rows of the snapshot decided
  // since, and rows that arrived since. An older Gateway without a total counts the page.
  const decidedSince = [...server.ids].filter((id) => byId[id]?.decision !== undefined).length;
  const arrivedSince = approvals.filter((a) => !server.ids.has(a.id)).length;
  const total = Math.max(
    0,
    (server.total ?? server.ids.size) - decidedSince + (multiPage.current ? 0 : arrivedSince),
  );
  return { approvals, loaded, error, replace: upsert, total, nextCursor: server.nextCursor };
}

export function ApprovalsScreen(props: ApprovalsScreenProps) {
  const api = props.api ?? defaultApi;
  // Cursors of the pages visited before this one; the last is the page shown (none: the first).
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);
  const { groups, loaded, error, totalGroups, totalApprovals, nextCursor, replace, reload } =
    usePendingApprovalGroups(api, cursor);
  const t = useT();
  const rangeText = usePageRangeText();
  const index = cursors.length;
  // A page emptied by decisions steps back to the one before it.
  useEffect(() => {
    if (loaded && groups.length === 0 && index > 0) setCursors((stack) => stack.slice(0, -1));
  }, [loaded, groups.length, index]);
  const from = index * PENDING_PAGE_SIZE + 1;
  // Resolve only the bots on this page. Persistent decisions need their workspace roles.
  const {
    bots,
    error: botLookupFailed,
    retry: retryBots,
  } = useBotLookup(
    api,
    groups.map((group) => group.approval.botId),
  );
  const botName = (botId: string): string => bots.get(botId)?.name ?? botId;

  return (
    <section className="approvals-screen page-container">
      <PageHeader title={t("approvals.title")} description={t("approvals.intro")} />
      {error ? (
        <div className="approval-load-error" role="alert">
          <p className="error">{error}</p>
          <Button onClick={reload}>{t("approvals.retry")}</Button>
        </div>
      ) : null}
      {botLookupFailed && groups.length > 0 ? (
        <div className="approval-load-error" role="alert">
          <p>{t("approvals.workspaceLookupFailed")}</p>
          <Button onClick={retryBots}>{t("approvals.retryWorkspaceLookup")}</Button>
        </div>
      ) : null}
      {!loaded ? (
        <p className="muted">{t("approvals.loading")}</p>
      ) : groups.length === 0 && !error ? (
        <EmptyState
          icon={<ShieldCheck size={22} />}
          title={t("approvals.empty.title")}
          action={<NextAction action="approval.decide" does={t("approvals.empty.nextDoes")} />}
        >
          {t("approvals.empty.body")}
        </EmptyState>
      ) : (
        <ul className="approval-list" aria-label={t("approvals.list")}>
          {groups.map((group) => {
            const approval = group.approval;
            return (
              <li key={group.key}>
                <ApprovalGroupActions
                  group={group}
                  api={api}
                  onDecided={reload}
                  workspaceId={bots.get(approval.botId)?.workspaceId ?? null}
                />
                <ApprovalCard
                  approval={approval}
                  workspaceId={bots.get(approval.botId)?.workspaceId ?? null}
                  compact
                  api={api}
                  onDecided={replace}
                  botName={botName(approval.botId)}
                >
                  <p className="approval-context small muted">
                    {t("approvals.age", { age: formatDuration(approval.createdAt, undefined) })}
                    {approval.threadId ? (
                      <>
                        {" · "}
                        <a href={threadHref(approval.threadId)}>{t("approvals.threadLink")}</a>
                      </>
                    ) : null}
                  </p>
                </ApprovalCard>
              </li>
            );
          })}
        </ul>
      )}
      {loaded && groups.length > 0 && (index > 0 || nextCursor !== undefined) ? (
        <Pager
          label={t("approvals.pages")}
          previousLabel={t("pager.previous")}
          nextLabel={t("pager.next")}
          range={rangeText({
            from,
            to: from + groups.length - 1,
            total: totalGroups,
            hasMore: nextCursor !== undefined,
          })}
          hasPrevious={index > 0}
          hasNext={nextCursor !== undefined}
          onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
          onNext={() => {
            if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
          }}
          rangeClassName="muted small"
        />
      ) : null}
      {loaded && totalApprovals > 0 ? (
        <p className="muted small approval-total">
          {t("approvals.totalRequests", { count: totalApprovals })}
        </p>
      ) : null}
    </section>
  );
}

function ApprovalGroupActions({
  group,
  api,
  onDecided,
  workspaceId,
}: {
  group: PendingApprovalGroup;
  workspaceId: string | null;
  api: ApiClient;
  onDecided: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const persistentRole = useCan("approval.decidePersistent", workspaceId ?? undefined);
  const canPersist = workspaceId !== null && persistentRole.allowed;
  if (group.count < 2) return null;
  const decide = async (decision: "allow_all" | "deny_all") => {
    if (
      pending.current ||
      (decision === "allow_all" && group.approval.kind === "egress" && !canPersist)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api.decideApprovalGroup(group.key, decision);
      onDecided();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="approval-group" data-testid="approval-group">
      <strong>{t("approvals.group.count", { count: group.count })}</strong>
      <div className="approval-group-actions">
        {group.approval.kind !== "egress" || canPersist ? (
          <Button
            size="sm"
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => void decide("allow_all")}
          >
            {t("approvals.group.allowAll")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={busy}
          onClick={() => void decide("deny_all")}
        >
          {t("approvals.group.denyAll")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="error small">
          {error}
        </p>
      ) : null}
    </div>
  );
}
