// @vitest-environment jsdom
// T0: the Files screen (ADR-0014 amendment A2, decisions 11 to 13 and 15).
import type {
  FileCollectionQuery,
  WorkspaceFileCollectionPage,
  WorkspaceFileItem,
} from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/types.js";
import { WS_ID, workspace } from "../../test-support/fixtures.js";
import { selectOption } from "../../test-support/select.js";
import { type FilesApi, WorkspaceFiles } from "./files.js";

afterEach(cleanup);

const AT = "2026-10-10T08:00:00.000Z";

function item(path: string, extra: Partial<WorkspaceFileItem> = {}): WorkspaceFileItem {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "documents",
    source: "bot",
    verification: "unverified",
    lastReferencedAt: AT,
    referenceCount: 1,
    references: [
      {
        kind: "message_path",
        at: AT,
        threadId: "thr_1" as never,
        threadTitle: "Weekly report",
        messageId: "msg_1" as never,
        authorKind: "bot",
        runId: "run_1" as never,
        botId: "bot_1" as never,
        botName: "nova",
      },
    ],
    ...extra,
  };
}

function page(
  items: WorkspaceFileItem[],
  extra: Partial<WorkspaceFileCollectionPage> = {},
): WorkspaceFileCollectionPage {
  const facets: WorkspaceFileCollectionPage["facets"] = {
    types: { documents: 0, images: 0, web: 0, other: 0 },
    sources: { bot: 0, uploaded: 0, unknown: 0 },
  };
  for (const value of items) {
    facets.types[value.kind] += 1;
    facets.sources[value.source] += 1;
  }
  return {
    scope: "published-results-and-inputs",
    items,
    total: items.length,
    offset: 0,
    limit: 25,
    truncated: false,
    facets,
    ...extra,
  };
}

/** jsdom's Blob lacks arrayBuffer; the preview needs only size and bytes. */
function textBlob(text: string): Blob {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
  } as Blob;
}

function fakeApi(
  respond: (
    query: Partial<FileCollectionQuery>,
  ) => WorkspaceFileCollectionPage | Promise<WorkspaceFileCollectionPage>,
  download: () => Promise<Blob> = async () => textBlob("# Report\n<b>x</b>"),
) {
  const listWorkspaceFiles = vi.fn(
    async (_workspaceId: string, query: Partial<FileCollectionQuery> = {}) => respond(query),
  );
  const downloadWorkspaceFile = vi.fn(download);
  const readWorkspaceFileRange = vi.fn(async () => {
    const blob = await download();
    return { blob, fileSize: blob.size, start: 0, end: Math.max(0, blob.size - 1) };
  });
  return {
    api: {
      listWorkspaceFiles,
      downloadWorkspaceFile,
      readWorkspaceFileRange,
      workspaceFileDownloadUrl: vi.fn(
        (_workspaceId: string, path: string) => `/api/files?path=${encodeURIComponent(path)}`,
      ),
    } as unknown as FilesApi,
    listWorkspaceFiles,
    downloadWorkspaceFile,
  };
}

const lastQuery = (spy: ReturnType<typeof fakeApi>["listWorkspaceFiles"]) =>
  spy.mock.calls.at(-1)?.[1];

describe("Files screen", () => {
  it("lists referenced files with name, type, source and last reference, and states the scope", async () => {
    const { api, listWorkspaceFiles } = fakeApi(() =>
      page([
        item("/work/report.md"),
        item("/home/nova/chart.png", { kind: "images", source: "unknown" }),
      ]),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    const table = await screen.findByRole("table", { name: "Files as a list" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Name", "Type", "Source", "Last referenced"]);
    expect(within(table).getByText("report.md")).toBeTruthy();
    expect(within(table).getByText("Unknown")).toBeTruthy();
    expect(within(table).getByText("Bot-created")).toBeTruthy();
    expect(
      screen.getByText(/Files lists formally delivered bot results the server verified/),
    ).toBeTruthy();
    expect(listWorkspaceFiles).toHaveBeenCalledWith(WS_ID, {
      offset: 0,
      limit: 25,
      type: "all",
      source: "all",
      q: "",
    });
    // ADR-0014 A5: Members and above get one upload control (a Guest's is hidden; see
    // upload-attach-button.test.tsx).
    expect(screen.getAllByRole("button", { name: /upload files/i })).toHaveLength(1);
  });

  it("filters by type and source, searches, and resets to the first page", async () => {
    const many = Array.from({ length: 25 }, (_, i) => item(`/work/f${i}.md`));
    const { api, listWorkspaceFiles } = fakeApi((query) =>
      page(many, {
        total: 30,
        offset: query.offset ?? 0,
        facets: {
          types: { documents: 30, images: 4, web: 2, other: 1 },
          sources: { bot: 29, uploaded: 1, unknown: 1 },
        },
      }),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    await screen.findByText("1–25 of 30");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastQuery(listWorkspaceFiles)?.offset).toBe(25));
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    await waitFor(() =>
      expect(lastQuery(listWorkspaceFiles)).toMatchObject({ type: "images", offset: 0 }),
    );
    expect(screen.getByRole("button", { name: "Images" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastQuery(listWorkspaceFiles)?.offset).toBe(25));
    await selectOption("Source", "Bot-created");
    await waitFor(() =>
      expect(lastQuery(listWorkspaceFiles)).toMatchObject({ source: "bot", offset: 0 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastQuery(listWorkspaceFiles)?.offset).toBe(25));
    fireEvent.change(screen.getByRole("textbox", { name: "Search files" }), {
      target: { value: " Report " },
    });
    await waitFor(() =>
      expect(lastQuery(listWorkspaceFiles)).toMatchObject({ q: "Report", offset: 0 }),
    );
  });

  it("shows server facet counts, active chips and Clear, but hides source until uploads exist", async () => {
    const { api } = fakeApi(() =>
      page([item("/work/report.md")], {
        facets: {
          types: { documents: 7, images: 3, web: 2, other: 1 },
          sources: { bot: 12, uploaded: 0, unknown: 1 },
        },
      }),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    const images = await screen.findByRole("button", { name: "Images" });
    expect(images.textContent).toContain("3");
    expect(screen.queryByText("Source", { selector: "label" })).toBeNull();
    fireEvent.click(images);
    expect(await screen.findByRole("group", { name: "Active filters" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Images" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true"),
    );
  });

  it("switches between list and grid", async () => {
    const { api } = fakeApi(() =>
      page([item("/work/a.md"), item("/work/site/index.html", { kind: "web" })]),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    const grid = screen.getByRole("list", { name: "Files as a grid" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
    expect(within(grid).getByText("Web · Bot-created")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a secondary path only when two names collide", async () => {
    const { api } = fakeApi(() =>
      page([item("/work/a/report.md"), item("/work/b/report.md"), item("/work/unique.md")]),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    await screen.findByRole("table");
    expect(screen.getByText("/work/a/")).toBeTruthy();
    expect(screen.getByText("/work/b/")).toBeTruthy();
    expect(screen.queryByText("/work/")).toBeNull();
  });

  it("opens details with location, provenance links and per-task delivery, never accepted", async () => {
    const report = item("/work/report.md", {
      referenceCount: 3,
      references: [
        {
          kind: "task_artifact",
          at: AT,
          taskId: "task_1",
          taskTitle: "Weekly report",
          label: "Final report",
          runId: "run_1" as never,
          botId: "bot_1" as never,
          botName: "nova",
          usedInDelivery: true,
        },
        { kind: "task_artifact", at: AT, taskId: "task_2", taskTitle: "Draft", label: "Draft" },
        {
          kind: "message_attachment",
          at: AT,
          threadId: "thr_1" as never,
          threadTitle: "Kickoff",
          messageId: "msg_2" as never,
          authorKind: "human",
        },
      ],
    });
    const { api } = fakeApi(() => page([report]));
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open details for /work/report.md" }),
    );
    const detail = screen.getByRole("complementary", { name: "Details for report.md" });
    expect(document.activeElement).toBe(detail);
    expect(within(detail).getByText("/work/report.md", { selector: "dd code" })).toBeTruthy();
    expect(within(detail).getAllByText("Used in delivery")).toHaveLength(1);
    expect(
      within(detail).getByRole("link", { name: "Task: Weekly report" }).getAttribute("href"),
    ).toBe("#/tasks/task_1");
    expect(within(detail).getByRole("link", { name: "Bot: nova" }).getAttribute("href")).toBe(
      "#/contacts/bot_1",
    );
    expect(within(detail).getByRole("link", { name: "Run" }).getAttribute("href")).toBe(
      "#/runs/run_1",
    );
    expect(within(detail).getByRole("link", { name: "Chat: Kickoff" }).getAttribute("href")).toBe(
      "#/threads/thr_1?message=msg_2",
    );
    expect(within(detail).getByText("No run recorded")).toBeTruthy();
    expect(within(detail).getByText("Posted by a person")).toBeTruthy();
    expect(detail.textContent).not.toMatch(/accepted/i);
    expect(within(detail).getByText(/not when the file changed/)).toBeTruthy();
    expect(
      within(detail).getByText("Known after a preview or download reads the file"),
    ).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows the checked version of a verified publication and labels legacy and inputs (A4)", async () => {
    const verified = item("/work/final.md", {
      verification: "verified",
      publication: {
        id: "fpub_1",
        taskId: "task_1",
        taskTitle: "Weekly report",
        taskDeleted: true,
        deliveryKind: "partial",
        label: "Final",
        sizeBytes: 42,
        sha256: "ab".repeat(32),
        check: "file-read-digest-v1",
        checkedAt: AT,
        publishedAt: AT,
        supersededCount: 1,
      },
    });
    const { api } = fakeApi(() =>
      page([verified, item("/work/old.md"), item("/work/brief.pdf", { verification: "input" })]),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open details for /work/final.md" }));
    const detail = screen.getByRole("complementary", { name: "Details for final.md" });
    expect(within(detail).getByText("Verified")).toBeTruthy();
    expect(within(detail).getByText(/Checked 42 bytes, SHA-256 abababababababab/)).toBeTruthy();
    expect(
      within(detail).getByText(/a partial delivery of task Weekly report \(task deleted/),
    ).toBeTruthy();
    expect(within(detail).getByText(/1 earlier version/)).toBeTruthy();
    expect(within(detail).getByText(/current bytes, which may differ/)).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "Close details" }));
    fireEvent.click(screen.getByRole("button", { name: "Open details for /work/old.md" }));
    const legacy = screen.getByRole("complementary", { name: "Details for old.md" });
    expect(within(legacy).getByText("Unverified (legacy)")).toBeTruthy();
    expect(within(legacy).getByText(/never checked/)).toBeTruthy();
  });

  it("previews text inertly and learns the size only from the read", async () => {
    const { api } = fakeApi(() => page([item("/work/report.md")]));
    const { container } = render(<WorkspaceFiles api={api} workspace={workspace} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open details for /work/report.md" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    expect((await screen.findByLabelText("Preview of /work/report.md")).textContent).toContain(
      "Report",
    );
    expect(container.querySelector(".files-detail b")).toBeNull();
    expect(screen.getByText("17 bytes")).toBeTruthy();
  });

  it("offers rich image preview and says honestly when the file is gone or workspace is stopped", async () => {
    let failure: ApiError = new ApiError("not_found", "x", 404, {
      reason: "workspace_not_running",
    });
    const { api } = fakeApi(
      () => page([item("/work/notes.txt"), item("/work/chart.png", { kind: "images" })]),
      async () => {
        throw failure;
      },
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open details for /work/chart.png" }),
    );
    expect(screen.getByRole("button", { name: "Preview file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download /work/chart.png" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open details for /work/notes.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /workspace is not running.*never starts it/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    failure = new ApiError("not_found", "x", 404, { reason: "file_not_found" });
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByText(/No file exists at this path now/);
    // The metadata stays visible while content is unavailable.
    expect(screen.getByText("/work/notes.txt", { selector: "dd code" })).toBeTruthy();
  });

  it("shows empty, filtered-empty, loading and error states", async () => {
    let answer: () => WorkspaceFileCollectionPage | Promise<WorkspaceFileCollectionPage> = () =>
      page([]);
    const { api, listWorkspaceFiles } = fakeApi(() => answer());
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    expect(screen.getByText("Loading files…")).toBeTruthy();
    await screen.findByText("No referenced files yet");
    fireEvent.click(screen.getByRole("button", { name: "Web" }));
    await screen.findByText("No matching files");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByText("No referenced files yet");
    answer = () => Promise.reject(new Error("Gateway unreachable"));
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Gateway unreachable");
    answer = () => page([item("/work/a.md")], { truncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Only the newest 10,000 references/);
    expect(listWorkspaceFiles.mock.calls.length).toBeGreaterThan(4);
  });

  it("ignores a late answer for filters that are no longer selected", async () => {
    let releaseOld: (value: WorkspaceFileCollectionPage) => void = () => {};
    const { api } = fakeApi((query) =>
      query.type === "images"
        ? page([item("/work/new.png", { kind: "images" })])
        : new Promise<WorkspaceFileCollectionPage>((resolve) => {
            releaseOld = resolve;
          }),
    );
    render(<WorkspaceFiles api={api} workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    await screen.findByText("new.png");
    await act(async () => releaseOld(page([item("/work/old.md")])));
    expect(screen.queryByText("old.md")).toBeNull();
    expect(screen.getByText("new.png")).toBeTruthy();
  });
});
