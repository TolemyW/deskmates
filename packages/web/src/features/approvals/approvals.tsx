// Approval inbox (M1): every pending approval in the deployment, across threads and bots.
//
// The inbox is a convenience, not a second authority: a row here is the same approval the thread
// shows inline, decided the same way (ADR-0002 amendment 2 — any member may decide). A row leaves
// the list as soon as it is decided, whoever decided it, because the `approval` frame the Gateway
// fans out on a decision carries the settled approval.

import type { Approval, BotDefinition } from "@deskmates/contracts";
import { Pager } from "@deskmates/ui";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ApiClient, api as defaultApi } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { EmptyState } from "../../components/ui/empty-state.js";
import { errorMessage, formatDuration } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { usePageRangeText } from "../../lib/page-bar.js";
import { threadHref } from "../../router.js";
import { newerApproval } from "../../state/newer-approval.js";
import { NextAction } from "../../state/session-roles.js";
import { ApprovalCard } from "./approval-card.js";

export interface ApprovalsScreenProps {
  api?: ApiClient;
}

/** The inbox page size; the Gateway's default for the pending queue (#113 surface 23). */
export const PENDING_PAGE_SIZE = 25;
/** How long a burst of approval frames is gathered before a multi-page view refetches. */
const MULTI_PAGE_REFETCH_MS = 250;

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
  const { approvals, loaded, error, replace, total, nextCursor } = usePendingApprovals(
    api,
    undefined,
    cursor,
  );
  const t = useT();
  const rangeText = usePageRangeText();
  const index = cursors.length;
  // A page emptied by decisions steps back to the one before it.
  useEffect(() => {
    if (loaded && approvals.length === 0 && index > 0) setCursors((stack) => stack.slice(0, -1));
  }, [loaded, approvals.length, index]);
  const from = index * PENDING_PAGE_SIZE + 1;
  const [bots, setBots] = useState<readonly BotDefinition[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listBots()
      .then((list) => {
        if (!cancelled) setBots(list);
      })
      .catch(() => {
        // A missing bot list only costs the row its display name; the inbox still works.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const botName = (botId: string): string => bots.find((b) => b.id === botId)?.name ?? botId;

  return (
    <section className="approvals-screen page-container">
      <header className="page-header">
        <div>
          <h1>{t("approvals.title")}</h1>
          <p>{t("approvals.intro")}</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {!loaded ? (
        <p className="muted">{t("approvals.loading")}</p>
      ) : approvals.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={22} />}
          title={t("approvals.empty.title")}
          action={<NextAction action="approval.decide" does={t("approvals.empty.nextDoes")} />}
        >
          {t("approvals.empty.body")}
        </EmptyState>
      ) : (
        <ul className="approval-list" aria-label={t("approvals.list")}>
          {approvals.map((a) => (
            <li key={a.id}>
              <ApprovalCard approval={a} api={api} onDecided={replace} botName={botName(a.botId)}>
                <p className="approval-context small muted">
                  <span className="author bot">{botName(a.botId)}</span> ·{" "}
                  {t("approvals.age", { age: formatDuration(a.createdAt, undefined) })}
                  {a.threadId ? (
                    <>
                      {" · "}
                      <a href={threadHref(a.threadId)}>{t("approvals.threadLink")}</a>
                    </>
                  ) : null}
                </p>
              </ApprovalCard>
            </li>
          ))}
        </ul>
      )}
      {loaded && approvals.length > 0 && (index > 0 || nextCursor !== undefined) ? (
        <Pager
          label={t("approvals.pages")}
          previousLabel={t("pager.previous")}
          nextLabel={t("pager.next")}
          range={rangeText({
            from,
            to: from + approvals.length - 1,
            total,
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
    </section>
  );
}
