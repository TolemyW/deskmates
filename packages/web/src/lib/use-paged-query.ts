// One bounded list page at a time (#113, pagination coverage plan §3.2). The hook owns the page
// position, the request sequence and the cursor history; the feature owns the request and the
// rendering. Rules it enforces:
//   - a change of `scopeKey` (workspace, filter, search, sort) returns to the first page, and the
//     old scope's position is never requested under the new one;
//   - only the latest request for the current scope is applied, however late an older one lands;
//   - a page emptied by a delete or acknowledgement steps back to the last page that has rows;
//   - a cursor the Gateway refuses (400) restarts the list from its first page;
//   - with `historyKey`, each page move is a history entry with the same address and the position
//     kept in `history.state`: Back and Forward step between pages, a reload restores the page,
//     and the route is untouched. A position saved under another scope is not restored.
// Cursors are opaque here: they come from the Gateway and go back unchanged.

import type { PageRange } from "@deskmates/ui";
import { useCallback, useEffect, useRef, useState } from "react";

export interface PageRequest {
  /** Rows before this page: the offset of an offset list, index × limit for a cursor list. */
  offset: number;
  limit: number;
  cursor?: string;
}

export interface PageResult<T> {
  items: T[];
  /** Honest total under the same filter, where the source can count cheaply. */
  total?: number;
  /** Present when there is a next cursor page. */
  nextCursor?: string;
}

export interface PagedQueryOptions<T> {
  /** Everything the list depends on besides its position; a change returns to the first page. */
  scopeKey: string;
  limit: number;
  mode: "offset" | "cursor";
  fetchPage: (request: PageRequest) => Promise<PageResult<T>>;
  /** Name of this list's position in `history.state`, for Back/Forward; omit to keep it in memory. */
  historyKey?: string;
}

export interface PagedQuery<T> {
  items: T[];
  page: PageResult<T> | undefined;
  loading: boolean;
  error: unknown;
  /** Zero-based index of the page shown. */
  index: number;
  range: PageRange | undefined;
  hasPrevious: boolean;
  hasNext: boolean;
  next: () => void;
  previous: () => void;
  /** Refetch the current page (after a change, a reconnect); the position is kept. */
  reload: () => void;
}

interface Position {
  index: number;
  cursor?: string;
}

const FIRST: Position = { index: 0 };

/** The key under which page positions live in `history.state`, one entry per list. */
const STATE_KEY = "deskmatesPages";

function statePages(): Record<string, unknown> {
  const state: unknown = typeof window === "undefined" ? undefined : window.history.state;
  const pages =
    state && typeof state === "object" ? (state as Record<string, unknown>)[STATE_KEY] : undefined;
  return pages && typeof pages === "object" ? (pages as Record<string, unknown>) : {};
}

function readPosition(
  key: string | undefined,
  mode: "offset" | "cursor",
  scopeKey: string,
): Position {
  if (!key) return FIRST;
  const raw = statePages()[key];
  if (!raw || typeof raw !== "object") return FIRST;
  const { index, cursor, scope } = raw as { index?: unknown; cursor?: unknown; scope?: unknown };
  if (scope !== scopeKey) return FIRST;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) return FIRST;
  if (mode === "offset") return { index };
  return typeof cursor === "string" && cursor ? { index, cursor } : FIRST;
}

/**
 * Record the position in the history entry's state. A page move adds an entry with the same
 * address; a reset or clamp replaces the entry. Other state (and other lists' positions) is kept.
 */
function writePosition(key: string, position: Position, scopeKey: string, replace: boolean): void {
  const pages = { ...statePages() };
  if (position.index === 0) delete pages[key];
  else pages[key] = { ...position, scope: scopeKey };
  const current: unknown = window.history.state;
  const state = { ...(current && typeof current === "object" ? current : {}), [STATE_KEY]: pages };
  if (replace) window.history.replaceState(state, "", window.location.href);
  else window.history.pushState(state, "", window.location.href);
}

const samePosition = (a: Position, b: Position) => a.index === b.index && a.cursor === b.cursor;

export function usePagedQuery<T>(options: PagedQueryOptions<T>): PagedQuery<T> {
  const { scopeKey, limit, mode, historyKey } = options;
  const fetchRef = useRef(options.fetchPage);
  fetchRef.current = options.fetchPage;
  const scopeRef = useRef(scopeKey);
  const [position, setPosition] = useState<Position>(() =>
    readPosition(historyKey, mode, scopeKey),
  );
  const positionRef = useRef(position);
  positionRef.current = position;
  const [loaded, setLoaded] = useState<{ result: PageResult<T>; index: number }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [reloadToken, setReloadToken] = useState(0);
  const sequence = useRef(0);
  // Cursor history: the cursor that opens each page index already visited in this scope.
  const cursors = useRef(new Map<number, string>());

  const go = useCallback(
    (next: Position, replace = false) => {
      if (samePosition(positionRef.current, next)) return;
      positionRef.current = next;
      if (historyKey) writePosition(historyKey, next, scopeRef.current, replace);
      setPosition(next);
    },
    [historyKey],
  );

  // Back/Forward: the history entry is the source of truth for the position.
  useEffect(() => {
    if (!historyKey) return;
    const onPop = () => {
      const next = readPosition(historyKey, mode, scopeRef.current);
      if (samePosition(positionRef.current, next)) return;
      positionRef.current = next;
      setPosition(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [historyKey, mode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the refetch trigger.
  useEffect(() => {
    if (scopeRef.current !== scopeKey) {
      scopeRef.current = scopeKey;
      cursors.current = new Map();
      if (position.index !== 0) {
        sequence.current += 1;
        go(FIRST, true);
        return;
      }
    }
    const request = ++sequence.current;
    const at = position;
    // A shown error stays until an answer replaces it, so "Retry" does not flicker away.
    setLoading(true);
    fetchRef
      .current({
        offset: at.index * limit,
        limit,
        ...(at.cursor ? { cursor: at.cursor } : {}),
      })
      .then((result) => {
        if (request !== sequence.current) return;
        if (result.nextCursor) cursors.current.set(at.index + 1, result.nextCursor);
        if (at.cursor) cursors.current.set(at.index, at.cursor);
        if (result.items.length === 0 && at.index > 0) {
          if (mode === "offset") {
            const last =
              result.total === undefined
                ? at.index - 1
                : Math.max(0, Math.ceil(result.total / limit) - 1);
            go({ index: Math.min(last, at.index - 1) }, true);
          } else {
            const index = at.index - 1;
            const cursor = cursors.current.get(index);
            go(index > 0 && cursor ? { index, cursor } : FIRST, true);
          }
          return;
        }
        setLoaded({ result, index: at.index });
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (request !== sequence.current) return;
        if (at.cursor && (err as { status?: unknown } | null)?.status === 400) {
          go(FIRST, true);
          return;
        }
        setLoaded(undefined);
        setError(err);
        setLoading(false);
      });
  }, [scopeKey, position, limit, mode, reloadToken, go]);

  // A late answer must never land after the list is gone.
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  const page = loaded?.result;
  const shownIndex = loaded?.index ?? 0;
  const items = page?.items ?? [];
  const hasNext =
    mode === "cursor"
      ? Boolean(page?.nextCursor)
      : page?.total !== undefined && shownIndex * limit + items.length < page.total;
  const from = shownIndex * limit + 1;
  const range: PageRange | undefined =
    page && items.length > 0
      ? {
          from,
          to: from + items.length - 1,
          ...(page.total !== undefined ? { total: page.total } : {}),
          hasMore: hasNext,
        }
      : undefined;

  const next = useCallback(() => {
    if (!hasNext) return;
    const index = shownIndex + 1;
    if (mode === "offset") go({ index });
    else {
      const cursor = page?.nextCursor;
      if (cursor) go({ index, cursor });
    }
  }, [go, hasNext, mode, page?.nextCursor, shownIndex]);

  const previous = useCallback(() => {
    if (shownIndex === 0) return;
    const index = shownIndex - 1;
    if (mode === "offset" || index === 0) go({ index });
    else {
      const cursor = cursors.current.get(index);
      go(cursor ? { index, cursor } : FIRST);
    }
  }, [go, mode, shownIndex]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return {
    items,
    page,
    loading,
    error,
    index: shownIndex,
    range,
    hasPrevious: shownIndex > 0,
    hasNext,
    next,
    previous,
    reload,
  };
}
