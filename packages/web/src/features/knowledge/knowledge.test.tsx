import { selectOption } from "../../test-support/select.js";
import "@testing-library/jest-dom/vitest";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { KnowledgePanel, KnowledgeScreen } from "./knowledge.js";

afterEach(cleanup);
it("shows pending Markdown as text and requires explicit publication", async () => {
  let approved = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(init?.credentials).toBe("same-origin");
    let body: unknown = {};
    if (path.endsWith("/review")) {
      expect(JSON.parse(String(init?.body))).toEqual({ decision: "approve" });
      approved = true;
      body = { proposal: { id: "kp_1", status: "approved" } };
    } else if (path.includes("proposals"))
      body = {
        proposals: approved
          ? []
          : [
              {
                id: "kp_1",
                title: "Refund draft",
                body: "<script>untrusted()</script>",
                status: "pending",
              },
            ],
      };
    else if (path === "/api/bots") body = { bots: [] };
    else body = { documents: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const api = createApiClient({ fetch: fetcher });
  const { container } = render(<KnowledgeScreen api={api} />);
  await screen.findByText("Refund draft");
  expect(approved).toBe(false);
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve and publish" }));
  await screen.findByText("Document published.");
  await waitFor(() => expect(screen.queryByText("Refund draft")).toBeNull());
});

it("pages documents and the whole pending queue instead of truncating them (#113)", async () => {
  const documents = Array.from({ length: 30 }, (_, i) => ({
    id: `doc_${i}`,
    title: `Doc ${i}`,
    excerpt: "",
    version: 1,
  }));
  const proposals = Array.from({ length: 27 }, (_, i) => ({
    id: `kp_${i}`,
    title: `Proposal ${i}`,
    body: "b",
    status: "pending",
  }));
  const urls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    urls.push(`${url.pathname}${url.search}`);
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (url.pathname === "/api/bots") return Response.json({ bots: [] });
    if (url.pathname === "/api/knowledge/proposals")
      return Response.json({
        proposals: proposals.slice(cursor, cursor + 25),
        total: proposals.length,
        ...(cursor + 25 < proposals.length ? { nextCursor: String(cursor + 25) } : {}),
      });
    if (url.searchParams.get("q"))
      return Response.json({
        documents: documents.slice(offset, offset + 25).slice(0, 2),
        offset,
        limit: 25,
        total: 2,
      });
    return Response.json({
      documents: documents.slice(cursor, cursor + 25),
      total: documents.length,
      ...(cursor + 25 < documents.length ? { nextCursor: String(cursor + 25) } : {}),
    });
  });
  render(<KnowledgePanel api={createApiClient({ fetch: fetcher })} />);
  const pending = await screen.findByRole("navigation", { name: "Pending proposal pages" });
  expect(await screen.findByText("Pending review (27)")).toBeTruthy();
  expect(pending.textContent).toContain("1–25 of 27");
  fireEvent.click(within(pending).getByRole("button", { name: "Next" }));
  await screen.findByText("Proposal 26");
  expect(pending.textContent).toContain("26–27 of 27");

  const docs = screen.getByRole("navigation", { name: "Document pages" });
  expect(docs.textContent).toContain("1–25 of 30");
  fireEvent.click(within(docs).getByRole("button", { name: "Next" }));
  await screen.findByRole("button", { name: "Doc 29 · v1" });
  // A new search starts its results from the first page, by offset with the honest match count.
  fireEvent.change(screen.getByLabelText("Search knowledge"), { target: { value: "doc" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: "Doc 0 · v1" });
  expect(screen.queryByRole("navigation", { name: "Document pages" })).not.toBeInTheDocument();
  expect(urls).toContain("/api/knowledge?q=doc&offset=0&limit=25");
});

it("sends the loaded memory version and retains the edit after a conflict", async () => {
  const write = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "PATCH") {
      write(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          code: "invalid_transition",
          message: "Memory changed; reload before editing",
        }),
        { status: 409 },
      );
    }
    const body = path.endsWith("/memory")
      ? { memory: { body: "old memory", version: "a".repeat(64) } }
      : path === "/api/bots"
        ? { bots: [{ id: "bot_1", name: "writer" }] }
        : path.includes("proposals")
          ? { proposals: [] }
          : { documents: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  render(<KnowledgeScreen api={createApiClient({ fetch: fetcher })} />);
  await screen.findByText("writer");
  await selectOption("Bot", "writer");
  await screen.findByDisplayValue("old memory");
  fireEvent.change(screen.getByLabelText("Instructions (Markdown)"), {
    target: { value: "edited memory" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await screen.findByRole("alert");
  expect(write).toHaveBeenCalledWith({ body: "edited memory", expectedVersion: "a".repeat(64) });
  await waitFor(() => expect(screen.getByDisplayValue("edited memory")).toBeTruthy());
  expect((await screen.findByLabelText("Latest saved memory")).textContent).toContain("old memory");
});

it("retains a knowledge draft across navigation and requires explicit discard before switching", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/bots") return Response.json({ bots: [] });
    if (path.includes("proposals")) return Response.json({ proposals: [] });
    if (path === "/api/knowledge/doc_1")
      return Response.json({
        document: { id: "doc_1", title: "First", body: "first body", version: 1 },
      });
    if (path === "/api/knowledge/doc_2")
      return Response.json({
        document: { id: "doc_2", title: "Second", body: "second body", version: 1 },
      });
    return Response.json({
      documents: [
        { id: "doc_1", title: "First", excerpt: "one", version: 1 },
        { id: "doc_2", title: "Second", excerpt: "two", version: 1 },
      ],
    });
  });
  const api = createApiClient({ fetch: fetcher });
  const firstRender = render(<KnowledgeScreen api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "First · v1" }));
  await screen.findByDisplayValue("first body");
  fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "local draft" } });
  firstRender.unmount();

  render(<KnowledgeScreen api={api} />);
  expect(await screen.findByDisplayValue("local draft")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Second · v1" }));
  expect(await screen.findByRole("alertdialog", { name: "Unsaved draft" })).toBeTruthy();
  expect(screen.getByDisplayValue("local draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByDisplayValue("local draft")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Second · v1" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and continue" }));
  expect(await screen.findByDisplayValue("second body")).toBeTruthy();
});

it("shows a conflicting knowledge version separately and rebases without replacing local text", async () => {
  let reads = 0;
  const edits: unknown[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/bots") return Response.json({ bots: [] });
    if (path.includes("proposals")) return Response.json({ proposals: [] });
    if (path === "/api/knowledge/doc_1" && init?.method === "PATCH") {
      edits.push(JSON.parse(String(init.body)));
      return Response.json(
        { code: "invalid_transition", message: "Document changed" },
        { status: 409 },
      );
    }
    if (path === "/api/knowledge/doc_1") {
      reads += 1;
      return Response.json({
        document:
          reads === 1
            ? { id: "doc_1", title: "Guide", body: "base", version: 1 }
            : { id: "doc_1", title: "Guide latest", body: "server update", version: 2 },
      });
    }
    return Response.json({
      documents: [{ id: "doc_1", title: "Guide", excerpt: "base", version: 1 }],
    });
  });
  render(<KnowledgeScreen api={createApiClient({ fetch: fetcher })} />);
  fireEvent.click(await screen.findByRole("button", { name: "Guide · v1" }));
  await screen.findByDisplayValue("base");
  fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "my local edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));

  const latest = await screen.findByLabelText("Latest saved knowledge");
  expect(latest.textContent).toContain("server update");
  expect(screen.getByDisplayValue("my local edit")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use latest version as base" }));
  expect(screen.getByDisplayValue("my local edit")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Edit approved document · v2" })).toBeTruthy();
  expect(edits).toEqual([{ title: "Guide", body: "my local edit", version: 1 }]);
});

it("opens the proposal editor on demand and keeps a draft when it is closed", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(String(input).includes("proposals") ? { proposals: [] } : { documents: [] }),
  );
  render(<KnowledgePanel api={createApiClient({ fetch: fetcher })} />);
  await screen.findByText("All caught up. No documents awaiting review.");
  expect(screen.queryByLabelText("Title")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New document" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved guide" } });
  fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "Keep these notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByLabelText("Title")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New document" }));
  expect(screen.getByLabelText("Title")).toHaveValue("Unsaved guide");
  expect(screen.getByLabelText("Markdown")).toHaveValue("Keep these notes");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("/review"))).toBe(true);
});

it("distinguishes loading and failed document requests from an empty library, then retries", async () => {
  const api = createApiClient({ fetch: async () => Response.json({ proposals: [], total: 0 }) });
  let fail: (error: Error) => void = () => {};
  vi.spyOn(api, "listKnowledgePage")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue({ documents: [], total: 0 });
  render(<KnowledgePanel api={api} />);
  expect(await screen.findByText("Loading documents…")).toBeVisible();
  fail(new Error("Library unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Library unavailable");
  expect(
    screen.queryByText("No published documents yet. Create a document to send it for review."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry documents" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(
    await screen.findByText("No published documents yet. Create a document to send it for review."),
  ).toBeVisible();
  expect(api.listKnowledgePage).toHaveBeenCalledTimes(2);
});

it("keeps a local draft when retrying a failed proposal queue", async () => {
  const api = createApiClient({ fetch: async () => Response.json({ documents: [], total: 0 }) });
  vi.spyOn(api, "listKnowledgeProposalsPage")
    .mockRejectedValueOnce(new Error("Queue unavailable"))
    .mockResolvedValue({ proposals: [], total: 0 });
  render(<KnowledgePanel api={api} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Queue unavailable");
  fireEvent.click(screen.getByRole("button", { name: "New document" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry proposals" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByLabelText("Title")).toHaveValue("Keep my draft");
});

it("distinguishes an unmatched search from an empty published library", async () => {
  const api = createApiClient({
    fetch: async (input) =>
      Response.json(
        String(input).includes("proposals")
          ? { proposals: [], total: 0 }
          : { documents: [], total: 0 },
      ),
  });
  render(<KnowledgePanel api={api} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search knowledge" }), {
    target: { value: "missing policy" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("No documents match “missing policy”.")).toBeVisible();
  expect(
    screen.queryByText("No published documents yet. Create a document to send it for review."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(
    await screen.findByText("No published documents yet. Create a document to send it for review."),
  ).toBeVisible();
  expect(screen.getByRole("searchbox", { name: "Search knowledge" })).toHaveValue("");
});
