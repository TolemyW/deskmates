import type { IncomingHandoff, ThreadId } from "@deskmates/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import { ButtonLink } from "../../components/ui/button.js";
import { Pill, runStatusTone } from "../../components/ui/pill.js";
import { errorMessage, formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import { runHref, threadHref } from "../../router.js";
import { runStatusLabel } from "../../state/thread-view.js";

/** Activity outside the model transcript. Reading it never posts a message or starts a run. */
export function IncomingHandoffs({
  api,
  threadId,
  onRuns,
}: { api: ApiClient; threadId: ThreadId; onRuns?: (ids: readonly string[]) => void }) {
  const [items, setItems] = useState<IncomingHandoff[]>([]);
  const [error, setError] = useState<string>();
  // #113 slice CH: newest page first; older handoffs load on request and stay loaded.
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const generation = useRef(0);
  const t = useT();
  useEffect(() => {
    let live = true;
    let revision = 0;
    const current = ++generation.current;
    setItems([]);
    setCursor(undefined);
    let olderLoaded = false;
    const refresh = async () => {
      const request = ++revision;
      try {
        const page = await api.listHandoffs(threadId);
        if (!live || request !== revision) return;
        const fresh = page.handoffs;
        const oldest = fresh.at(-1)?.seq ?? Number.MAX_SAFE_INTEGER;
        let next: IncomingHandoff[] = fresh;
        setItems((loaded) => {
          // Older pages already loaded stay below the refreshed first page.
          next = [...fresh, ...loaded.filter((item) => item.seq < oldest)];
          return next;
        });
        if (!olderLoaded) setCursor(page.nextCursor);
        onRuns?.(fresh.map((item) => item.runId));
        setError(undefined);
        if (document.visibilityState !== "hidden" && next.some((item) => item.unread)) {
          await api.readHandoffs(
            threadId,
            next.reduce((last, item) => Math.max(last, item.seq), 0),
          );
        }
      } catch (err) {
        if (live && request === revision) setError(errorMessage(err));
      }
    };
    void refresh();
    const stop = subscribeEvents({
      threadId,
      onEvent: (event) => {
        if (event.type === "thread_activity") void refresh();
      },
      onReconnect: () => {
        void refresh();
      },
    });
    const visible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    olderRef.current = () => {
      olderLoaded = true;
    };
    return () => {
      live = false;
      if (generation.current === current) generation.current += 1;
      stop();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, threadId, onRuns]);
  const olderRef = useRef<() => void>(() => {});
  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    const current = generation.current;
    setLoadingOlder(true);
    try {
      const page = await api.listHandoffs(threadId, cursor);
      if (generation.current !== current) return;
      olderRef.current();
      setItems((loaded) => {
        const seen = new Set(loaded.map((item) => item.seq));
        return [...loaded, ...page.handoffs.filter((item) => !seen.has(item.seq))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setLoadingOlder(false);
    }
  };
  if (error)
    return (
      <li className="message system">
        <p className="error">{t("incomingHandoffs.loadError", { error })}</p>
      </li>
    );
  return (
    <>
      {cursor ? (
        <li className="incoming-handoff-older">
          <button
            type="button"
            className="link-button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? t("incomingHandoffs.loadingOlder") : t("incomingHandoffs.loadOlder")}
          </button>
        </li>
      ) : null}
      {items
        .slice()
        .reverse()
        .map((item) => (
          <li key={item.seq} className="incoming-handoff">
            <div className="incoming-handoff-heading">
              <strong>{t("incomingHandoffs.requested", { name: item.callerName })}</strong>
              <span className="muted small">{formatTime(item.createdAt)}</span>
            </div>
            <p>{item.excerpt}</p>
            <div className="incoming-handoff-links">
              <Pill tone={runStatusTone(item.status)}>
                {item.status === "succeeded"
                  ? t("incomingHandoffs.status.completed")
                  : item.status === "silent"
                    ? t("incomingHandoffs.status.silent")
                    : runStatusLabel(item.status)}
              </Pill>
              <ButtonLink
                size="sm"
                variant="ghost"
                href={threadHref(item.sourceThreadId, item.sourceMessageId)}
              >
                {t("incomingHandoffs.viewOriginal")}
              </ButtonLink>
              <ButtonLink size="sm" variant="ghost" href={threadHref(item.handoffThreadId)}>
                {t("incomingHandoffs.openCollaboration")}
              </ButtonLink>
              <ButtonLink size="sm" variant="ghost" href={runHref(item.runId)}>
                {t("incomingHandoffs.viewRun")}
              </ButtonLink>
            </div>
          </li>
        ))}
    </>
  );
}
