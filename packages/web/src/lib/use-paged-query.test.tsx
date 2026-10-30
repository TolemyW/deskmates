// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../api/types.js";
import { PageBar } from "./page-bar.js";
import { type PageRequest, type PageResult, usePagedQuery } from "./use-paged-query.js";

beforeEach(() => {
  history.replaceState(null, "", "#/things");
});
afterEach(cleanup);

/** 60 rows `r0`..`r59`, served by offset with a total. */
function offsetSource(count = 60) {
  const rows = Array.from({ length: count }, (_, i) => `r${i}`);
  const requests: PageRequest[] = [];
  return {
    rows,
    requests,
    fetchPage: async (request: PageRequest): Promise<PageResult<string>> => {
      requests.push(request);
      return {
        items: rows.slice(request.offset, request.offset + request.limit),
        total: rows.length,
      };
    },
  };
}

/** The same rows served by cursor (the cursor is the next index, base64url-safe). */
function cursorSource(count = 60) {
  const rows = Array.from({ length: count }, (_, i) => `r${i}`);
  return {
    rows,
    fetchPage: async (request: PageRequest): Promise<PageResult<string>> => {
      const start = request.cursor ? Number(request.cursor.slice(1)) : 0;
      const items = rows.slice(start, start + request.limit);
      const next = start + request.limit;
      return next < rows.length ? { items, nextCursor: `c${next}` } : { items };
    },
  };
}

describe("usePagedQuery offset pages", () => {
  it("moves across more than two pages with an honest range", async () => {
    const source = offsetSource();
    const { result } = renderHook(() =>
      usePagedQuery({ scopeKey: "a", limit: 25, mode: "offset", fetchPage: source.fetchPage }),
    );
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    expect(result.current.range).toEqual({ from: 1, to: 25, total: 60, hasMore: true });
    expect(result.current.hasPrevious).toBe(false);
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r50"));
    expect(result.current.range).toEqual({ from: 51, to: 60, total: 60, hasMore: false });
    expect(result.current.hasNext).toBe(false);
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
  });

  it("returns to the first page when the scope changes", async () => {
    const source = offsetSource();
    const { result, rerender } = renderHook(
      ({ scope }) =>
        usePagedQuery({ scopeKey: scope, limit: 25, mode: "offset", fetchPage: source.fetchPage }),
      { initialProps: { scope: "a" } },
    );
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.index).toBe(1));
    rerender({ scope: "b" });
    await waitFor(() => expect(result.current.index).toBe(0));
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    // The old scope's position was never requested under the new scope.
    expect(source.requests.at(-1)).toEqual({ offset: 0, limit: 25 });
  });

  it("discards a slow answer for an older scope", async () => {
    const resolvers: Array<(value: PageResult<string>) => void> = [];
    const fetchPage = (_request: PageRequest) =>
      new Promise<PageResult<string>>((resolve) => resolvers.push(resolve));
    const { result, rerender } = renderHook(
      ({ scope }) => usePagedQuery({ scopeKey: scope, limit: 25, mode: "offset", fetchPage }),
      { initialProps: { scope: "old" } },
    );
    rerender({ scope: "new" });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]?.({ items: ["fresh"], total: 1 }));
    await act(async () => resolvers[0]?.({ items: ["stale"], total: 1 }));
    expect(result.current.items).toEqual(["fresh"]);
  });

  it("clamps to the last page that has rows after its rows are removed", async () => {
    const source = offsetSource(51);
    const { result } = renderHook(() =>
      usePagedQuery({ scopeKey: "a", limit: 25, mode: "offset", fetchPage: source.fetchPage }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    act(() => result.current.next());
    // A second click before the page arrives does not skip a page.
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items).toEqual(["r50"]));
    source.rows.splice(50, 1);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.index).toBe(1));
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    expect(result.current.hasNext).toBe(false);
  });

  it("makes each page move a history entry so Back and Forward step between pages", async () => {
    const source = offsetSource();
    const options = {
      scopeKey: "a",
      limit: 25,
      mode: "offset" as const,
      fetchPage: source.fetchPage,
      historyKey: "things",
    };
    const { result, unmount } = renderHook(() => usePagedQuery(options));
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    const first = history.state;
    const before = history.length;
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    expect(history.length).toBe(before + 1);
    expect(location.hash).toBe("#/things");
    const second = history.state;
    // Back: the browser restores the earlier entry's state and fires popstate.
    act(() => {
      history.replaceState(first, "", location.href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: first }));
    });
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    // Forward.
    act(() => {
      history.replaceState(second, "", location.href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: second }));
    });
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    // A reload (a new mount) restores the page; another scope does not.
    unmount();
    const again = renderHook(() => usePagedQuery(options));
    await waitFor(() => expect(again.result.current.items[0]).toBe("r25"));
    again.unmount();
    const other = renderHook(() => usePagedQuery({ ...options, scopeKey: "b" }));
    await waitFor(() => expect(other.result.current.items[0]).toBe("r0"));
  });
});

describe("usePagedQuery cursor pages", () => {
  it("walks forward with cursors, back with the visited stack, and says 'more' without a total", async () => {
    const source = cursorSource();
    const { result } = renderHook(() =>
      usePagedQuery({
        scopeKey: "a",
        limit: 25,
        mode: "cursor",
        fetchPage: source.fetchPage,
        historyKey: "after",
      }),
    );
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    expect(result.current.range).toEqual({ from: 1, to: 25, hasMore: true });
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    expect(history.state.deskmatesPages.after).toEqual({ index: 1, cursor: "c25", scope: "a" });
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]).toBe("r50"));
    expect(result.current.range).toEqual({ from: 51, to: 60, hasMore: false });
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.items[0]).toBe("r25"));
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.items[0]).toBe("r0"));
    expect(history.state.deskmatesPages.after).toBeUndefined();
  });

  it("restarts from the first page when the Gateway refuses a cursor", async () => {
    history.replaceState(
      { deskmatesPages: { after: { index: 1, cursor: "foreign", scope: "a" } } },
      "",
      location.href,
    );
    const fetchPage = async (request: PageRequest): Promise<PageResult<string>> => {
      if (request.cursor) throw new ApiError("validation", "Invalid pagination cursor", 400);
      return { items: ["first"] };
    };
    const { result } = renderHook(() =>
      usePagedQuery({ scopeKey: "a", limit: 25, mode: "cursor", fetchPage, historyKey: "after" }),
    );
    await waitFor(() => expect(result.current.items).toEqual(["first"]));
    expect(result.current.index).toBe(0);
    expect(history.state.deskmatesPages.after).toBeUndefined();
  });

  it("steps back when the last cursor page is emptied", async () => {
    const source = cursorSource(26);
    const { result } = renderHook(() =>
      usePagedQuery({ scopeKey: "a", limit: 25, mode: "cursor", fetchPage: source.fetchPage }),
    );
    await waitFor(() => expect(result.current.hasNext).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items).toEqual(["r25"]));
    source.rows.splice(25, 1);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.index).toBe(0));
    await waitFor(() => expect(result.current.hasNext).toBe(false));
  });
});

describe("PageBar", () => {
  function Bar({ total }: { total?: number }) {
    const query = usePagedQuery({
      scopeKey: "a",
      limit: 25,
      mode: "cursor",
      fetchPage: async () => ({
        items: ["x", "y"],
        ...(total === undefined ? { nextCursor: "c25" } : { total }),
      }),
    });
    return (
      <>
        {query.items.map((item) => (
          <span key={item}>{item}</span>
        ))}
        <PageBar query={query} label="Things pages" />
      </>
    );
  }

  it("says 'of more' rather than inventing a total", async () => {
    render(<Bar />);
    expect(await screen.findByText("1–2 of more")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Things pages" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("hides navigation when the counted result fits on one page", async () => {
    render(<Bar total={2} />);
    await screen.findByText("y");
    expect(screen.queryByRole("navigation", { name: "Things pages" })).not.toBeInTheDocument();
  });
});
