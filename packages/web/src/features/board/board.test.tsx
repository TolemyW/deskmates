// @vitest-environment jsdom
// T0: the message board (ADR-0022 amendment 6 W10). The list pages newest first with the
// Gateway's cursor; a post carries a request id that a retry reuses; edit and withdraw show only
// on the session's own posts; hide and unhide only when the Gateway says the session moderates.
import "@testing-library/jest-dom/vitest";
import "../../test-support/select.js";
import type { BoardPageView, BoardPostView, Workspace } from "@deskmates/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { BoardScreen } from "./board.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WS = { id: "ws_1", name: "Ops" } as Workspace;

function post(n: number, extra: Partial<BoardPostView> = {}): BoardPostView {
  return {
    id: `bp_${n}`,
    workspaceId: WS.id,
    author: "user:usr_other",
    authorDisplayName: "Alex",
    body: `Note ${n}`,
    state: "visible",
    version: 1,
    createdAt: `2026-10-13T10:${String(60 - n).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-10-13T10:${String(60 - n).padStart(2, "0")}:00.000Z`,
    mine: false,
    ...extra,
  };
}

function fakeApi(pages: Record<string, BoardPageView>) {
  const api = {
    listWorkspaces: vi.fn(async () => [WS]),
    listBoardPosts: vi.fn(
      async (_ws: string, page: { before?: string } = {}) => pages[page.before ?? "first"],
    ),
    createBoardPost: vi.fn(),
    editBoardPost: vi.fn(),
    withdrawBoardPost: vi.fn(),
    moderateBoardPost: vi.fn(),
    boardPostHistory: vi.fn(async () => []),
  };
  return { api, client: api as unknown as ApiClient };
}

it("lists posts newest first and loads older ones with the cursor", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1), post(2)], nextCursor: "cur_2", canModerate: false },
    cur_2: { posts: [post(3)], canModerate: false },
  });
  render(<BoardScreen api={client} />);
  const list = await screen.findByRole("list", { name: "Posts" });
  await waitFor(() => expect(within(list).getAllByTestId("board-post")).toHaveLength(2));
  expect(api.listBoardPosts).toHaveBeenCalledWith(WS.id, { limit: 50 });
  expect(within(list).getAllByTestId("board-post")[0]).toHaveTextContent("Note 1");

  fireEvent.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(within(list).getAllByTestId("board-post")).toHaveLength(3));
  expect(api.listBoardPosts).toHaveBeenLastCalledWith(WS.id, { before: "cur_2", limit: 50 });
  expect(within(list).getAllByTestId("board-post")[2]).toHaveTextContent("Note 3");
  // The last page has no cursor, so there is nothing older to load.
  expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
});

it("renders a post body as plain text", async () => {
  const { client } = fakeApi({
    first: {
      posts: [post(1, { body: "<img src=x onerror=alert(1)> **bold**" })],
      canModerate: false,
    },
  });
  const { container } = render(<BoardScreen api={client} />);
  expect(await screen.findByText("<img src=x onerror=alert(1)> **bold**")).toBeInTheDocument();
  expect(container.querySelector(".board-post-body img, .board-post-body strong")).toBeNull();
});

it("names the audience and sends a request id that a retry reuses", async () => {
  const { api, client } = fakeApi({ first: { posts: [], canModerate: false } });
  api.createBoardPost
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValueOnce(post(9, { body: "Hello all", mine: true }));
  render(<BoardScreen api={client} />);
  expect(await screen.findByTestId("board-audience")).toHaveTextContent(
    "Everyone in this workspace can read this, Guests included.",
  );
  fireEvent.change(screen.getByLabelText("New post"), { target: { value: "Hello all" } });
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  await screen.findByText("Hello all");
  expect(api.createBoardPost).toHaveBeenCalledTimes(2);
  const [first, second] = api.createBoardPost.mock.calls.map((call) => call[1]);
  expect(first.body).toBe("Hello all");
  expect(typeof first.clientRequestId).toBe("string");
  expect(first.clientRequestId.length).toBeGreaterThan(0);
  expect(second.clientRequestId).toBe(first.clientRequestId);
  expect(screen.getByLabelText("New post")).toHaveValue("");
});

it("offers edit and withdraw only on the session's own posts", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1, { mine: true, body: "Mine" }), post(2)], canModerate: false },
  });
  api.withdrawBoardPost.mockResolvedValue(post(1, { mine: true, state: "withdrawn" }));
  api.editBoardPost.mockResolvedValue(post(1, { mine: true, body: "Mine, edited", version: 2 }));
  render(<BoardScreen api={client} />);
  const list = await screen.findByRole("list", { name: "Posts" });
  await waitFor(() => expect(within(list).getAllByTestId("board-post")).toHaveLength(2));
  const [mine, theirs] = within(list).getAllByTestId("board-post") as [HTMLElement, HTMLElement];
  expect(
    within(theirs).queryByRole("button", { name: "Post options for Alex" }),
  ).not.toBeInTheDocument();
  expect(within(theirs).queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
  expect(within(theirs).queryByRole("button", { name: "Hide" })).not.toBeInTheDocument();

  fireEvent.click(within(mine).getByRole("button", { name: "Post options for Alex" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  fireEvent.change(within(mine).getByLabelText("Edit post"), {
    target: { value: "Mine, edited" },
  });
  fireEvent.click(within(mine).getByRole("button", { name: "Save" }));
  await within(list).findByText("Mine, edited");
  expect(api.editBoardPost).toHaveBeenCalledWith(WS.id, "bp_1", "Mine, edited");

  fireEvent.click(within(mine).getByRole("button", { name: "Post options for Alex" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Withdraw" }));
  await waitFor(() => expect(within(list).getAllByTestId("board-post")).toHaveLength(1));
  expect(api.withdrawBoardPost).toHaveBeenCalledWith(WS.id, "bp_1");
});

it("offers hide and unhide only when the session moderates, and marks hidden posts", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1), post(2, { state: "hidden" })], canModerate: true },
  });
  api.moderateBoardPost.mockResolvedValue(post(1, { state: "hidden" }));
  render(<BoardScreen api={client} />);
  const list = await screen.findByRole("list", { name: "Posts" });
  await waitFor(() => expect(within(list).getAllByTestId("board-post")).toHaveLength(2));
  const [visible, hidden] = within(list).getAllByTestId("board-post") as [HTMLElement, HTMLElement];
  expect(hidden).toHaveTextContent("Hidden by a moderator");
  fireEvent.click(within(hidden).getByRole("button", { name: "Post options for Alex" }));
  expect(await screen.findByRole("menuitem", { name: "Unhide" })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.click(within(visible).getByRole("button", { name: "Post options for Alex" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }));
  await waitFor(() =>
    expect(api.moderateBoardPost).toHaveBeenCalledWith(WS.id, "bp_1", { hidden: true }),
  );
  await waitFor(() => expect(within(list).getAllByText("Hidden by a moderator")).toHaveLength(2));
});

it("recovers a failed board read while preserving the composer draft", async () => {
  const { api, client } = fakeApi({ first: { posts: [post(1)], canModerate: false } });
  api.listBoardPosts.mockRejectedValueOnce(new Error("Board unavailable"));
  render(<BoardScreen api={client} />);
  await screen.findByRole("alert");
  expect(screen.queryByText("No posts yet.")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "New post" }), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Note 1");
  expect(screen.getByRole("textbox", { name: "New post" })).toHaveValue("Keep this draft");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.createBoardPost).not.toHaveBeenCalled();
});

it("retries the failed older page without discarding current posts", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1)], nextCursor: "older", canModerate: false },
    older: { posts: [post(2)], canModerate: false },
  });
  render(<BoardScreen api={client} />);
  await screen.findByText("Note 1");
  api.listBoardPosts.mockRejectedValueOnce(new Error("Older posts unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Load older" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Note 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Note 2");
  expect(api.listBoardPosts).toHaveBeenLastCalledWith(WS.id, { before: "older", limit: 50 });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a failed edit draft, prevents duplicate saves, and clears the error on cancel", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1, { mine: true, body: "Original" })], canModerate: false },
  });
  let rejectSave: (reason: Error) => void = () => {};
  api.editBoardPost.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  );
  render(<BoardScreen api={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Post options for Alex" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const editor = screen.getByLabelText("Edit post");
  expect(editor).toHaveFocus();
  fireEvent.change(editor, { target: { value: "Keep my edit" } });
  const form = editor.closest("form");
  if (!form) throw new Error("Missing edit form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(api.editBoardPost).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  rejectSave(new Error("Save unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(editor).toHaveValue("Keep my edit");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("Original")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Post options for Alex" })).toHaveFocus();
});

it("recovers history reads and invalidates the snapshot after editing a post", async () => {
  const { api, client } = fakeApi({
    first: { posts: [post(1, { mine: true })], canModerate: false },
  });
  api.boardPostHistory.mockRejectedValueOnce(new Error("History unavailable"));
  api.editBoardPost.mockResolvedValue(post(1, { mine: true, body: "Updated note", version: 2 }));
  render(<BoardScreen api={client} />);
  const options = await screen.findByRole("button", { name: "Post options for Alex" });
  fireEvent.click(options);
  fireEvent.click(await screen.findByRole("menuitem", { name: "History" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
  fireEvent.click(options);
  fireEvent.click(await screen.findByRole("menuitem", { name: "History" }));
  await screen.findByRole("list", { name: "Versions" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(options);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Updated note" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Updated note");
  expect(screen.queryByRole("list", { name: "Versions" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Post options for Alex" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "History" }));
  await waitFor(() => expect(api.boardPostHistory).toHaveBeenCalledTimes(3));
});
