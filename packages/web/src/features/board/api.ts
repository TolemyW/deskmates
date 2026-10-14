// The workspace message board (ADR-0022 amendment 6 W10): a paged list, newest first, that every
// member of the workspace reads and posts on, Guests included. Authors edit and withdraw their
// posts; Admins and Owners hide and unhide them. A post is inert: it never starts a run.

import type {
  BoardPageView,
  BoardPostVersionView,
  BoardPostView,
  WorkspaceId,
} from "@deskmates/contracts";
import { type HttpTransport, query, stripUndefined } from "../../platform/http-transport.js";

export interface BoardApi {
  /** `before` is the previous page's `nextCursor`; the first page when absent. */
  listBoardPosts(
    workspaceId: WorkspaceId,
    page?: { before?: string; limit?: number },
  ): Promise<BoardPageView>;
  /** `clientRequestId` makes a retry return the first post instead of a second one. */
  createBoardPost(
    workspaceId: WorkspaceId,
    input: { body: string; clientRequestId?: string },
  ): Promise<BoardPostView>;
  editBoardPost(workspaceId: WorkspaceId, postId: string, body: string): Promise<BoardPostView>;
  withdrawBoardPost(workspaceId: WorkspaceId, postId: string): Promise<BoardPostView>;
  moderateBoardPost(
    workspaceId: WorkspaceId,
    postId: string,
    input: { hidden: boolean; reason?: string },
  ): Promise<BoardPostView>;
  boardPostHistory(workspaceId: WorkspaceId, postId: string): Promise<BoardPostVersionView[]>;
}

function boardPath(workspaceId: WorkspaceId, postId?: string): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/board`;
  return postId === undefined ? base : `${base}/${encodeURIComponent(postId)}`;
}

export function createBoardApi(t: HttpTransport): BoardApi {
  return {
    listBoardPosts(workspaceId, page = {}) {
      return t.json("GET", `${boardPath(workspaceId)}${query({ ...page })}`);
    },
    async createBoardPost(workspaceId, input) {
      return (
        await t.json<{ post: BoardPostView }>("POST", boardPath(workspaceId), stripUndefined(input))
      ).post;
    },
    async editBoardPost(workspaceId, postId, body) {
      return (
        await t.json<{ post: BoardPostView }>("PATCH", boardPath(workspaceId, postId), { body })
      ).post;
    },
    async withdrawBoardPost(workspaceId, postId) {
      return (
        await t.json<{ post: BoardPostView }>(
          "POST",
          `${boardPath(workspaceId, postId)}/withdraw`,
          {},
        )
      ).post;
    },
    async moderateBoardPost(workspaceId, postId, input) {
      return (
        await t.json<{ post: BoardPostView }>(
          "POST",
          `${boardPath(workspaceId, postId)}/moderate`,
          stripUndefined(input),
        )
      ).post;
    },
    async boardPostHistory(workspaceId, postId) {
      return (
        await t.json<{ versions: BoardPostVersionView[] }>(
          "GET",
          `${boardPath(workspaceId, postId)}/history`,
        )
      ).versions;
    },
  };
}
