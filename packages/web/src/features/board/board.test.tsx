// @vitest-environment jsdom
// T0: the message board (ADR-0022 amendment 6 W10). The list pages newest first with the
// Gateway's cursor; a post carries a request id that a retry reuses; edit and withdraw show only
// on the session's own posts; hide and unhide only when the Gateway says the session moderates.
import "@testing-library/jest-dom/vitest";
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
  expect(within(theirs).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(within(theirs).queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
  expect(within(theirs).queryByRole("button", { name: "Hide" })).not.toBeInTheDocument();

  fireEvent.click(within(mine).getByRole("button", { name: "Edit" }));
  fireEvent.change(within(mine).getByLabelText("Edit post"), {
    target: { value: "Mine, edited" },
  });
  fireEvent.click(within(mine).getByRole("button", { name: "Save" }));
  await within(list).findByText("Mine, edited");
  expect(api.editBoardPost).toHaveBeenCalledWith(WS.id, "bp_1", "Mine, edited");

  fireEvent.click(within(list).getAllByRole("button", { name: "Withdraw" })[0] as HTMLElement);
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
  expect(within(hidden).getByRole("button", { name: "Unhide" })).toBeInTheDocument();
  fireEvent.click(within(visible).getByRole("button", { name: "Hide" }));
  await waitFor(() =>
    expect(api.moderateBoardPost).toHaveBeenCalledWith(WS.id, "bp_1", { hidden: true }),
  );
  await waitFor(() => expect(within(list).getAllByText("Hidden by a moderator")).toHaveLength(2));
});
