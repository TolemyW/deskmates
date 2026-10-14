// A bot's or thread's run feed, bounded (#113 slice R, surfaces 27 and 30): every unfinished run
// (bounded by the lanes) plus the newest page of finished runs, older pages on request with the
// Gateway's keyset cursor. Live `run_status` frames merge in without moving what is loaded; a
// reconnect refreshes the first pages and keeps the older ones. A response for a previous scope
// or an older request is discarded.

import type { BotId, ThreadId } from "@deskmates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { subscribeEvents } from "../../api/events.js";
import type { RunView } from "../../api/types.js";
import { errorMessage } from "../../format.js";
import { newerRun } from "../../state/newer-run.js";

/** Finished runs per page; the Gateway's default for the run list. */
export const RUN_FEED_PAGE = 20;

export interface RunFeedScope {
  botId?: BotId;
  threadId?: ThreadId;
}

export interface RunFeed {
  runs: readonly RunView[];
  /** Older finished runs exist beyond what is loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  error: string | undefined;
}

/**
 * The first page of a scope: the Gateway puts every unfinished run and the newest finished ones
 * on it; `nextCursor` continues with older finished runs.
 */
export function firstRunPages(
  api: Pick<ApiClient, "listRuns">,
  scope: RunFeedScope,
): Promise<{ runs: RunView[]; nextCursor?: string }> {
  return api.listRuns(scope);
}

function merge(
  current: readonly RunView[],
  incoming: readonly RunView[],
  accept: (run: RunView) => boolean = () => true,
): RunView[] {
  const byId = new Map(current.map((run) => [run.id as string, run]));
  for (const run of incoming) {
    if (!accept(run)) continue;
    byId.set(run.id, newerRun(byId.get(run.id), run));
  }
  return [...byId.values()];
}

export function useRunFeed(
  api: ApiClient,
  scope: RunFeedScope | undefined,
  opts: { live?: boolean } = {},
): RunFeed {
  const live = opts.live ?? true;
  const botId = scope?.botId;
  const threadId = scope?.threadId;
  const [runs, setRuns] = useState<RunView[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  // Bumped on every scope change; a response that started under another generation is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setRuns([]);
    setCursor(undefined);
    setError(undefined);
    if (!botId && !threadId) return;
    const feedScope: RunFeedScope = {
      ...(botId ? { botId } : {}),
      ...(threadId ? { threadId } : {}),
    };
    let request = 0;
    // A live frame newer than a snapshot request wins over the snapshot's copy of that run.
    const revisions = new Map<string, number>();
    const refresh = async (keepCursor: boolean) => {
      const id = ++request;
      const before = new Map(revisions);
      try {
        const page = await firstRunPages(api, feedScope);
        if (generation.current !== current || id !== request) return;
        setRuns((loaded) =>
          merge(loaded, page.runs, (run) => revisions.get(run.id) === before.get(run.id)),
        );
        if (!keepCursor) setCursor(page.nextCursor);
        setError(undefined);
      } catch (err) {
        if (generation.current === current && id === request) setError(errorMessage(err));
      }
    };
    // A screen rendered without an event stream (no EventSource) still loads its first page.
    const stop =
      live && globalThis.EventSource
        ? subscribeEvents({
            ...(threadId ? { threadId } : {}),
            onEvent: (event) => {
              if (generation.current !== current || event.type !== "run_status") return;
              const run = event.run;
              if ((botId && run.botId !== botId) || (threadId && run.threadId !== threadId)) return;
              // A finished summary job (ADR-0033) changed a card's summary: reload the first pages.
              if (run.config.runType === "activity_summary" && run.status !== "queued")
                void refresh(true);
              revisions.set(run.id, (revisions.get(run.id) ?? 0) + 1);
              setRuns((loaded) => merge(loaded, [run]));
            },
            onReconnect: () => void refresh(true),
          })
        : () => {};
    void refresh(false);
    return () => {
      generation.current += 1;
      stop();
    };
  }, [api, botId, threadId, live]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    const current = generation.current;
    setLoadingOlder(true);
    try {
      const page = await api.listRuns({
        ...(botId ? { botId } : {}),
        ...(threadId ? { threadId } : {}),
        cursor,
      });
      if (generation.current !== current) return;
      setRuns((loaded) => merge(loaded, page.runs));
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setLoadingOlder(false);
    }
  }, [api, botId, threadId, cursor, loadingOlder]);

  return { runs, hasOlder: cursor !== undefined, loadingOlder, loadOlder, error };
}
