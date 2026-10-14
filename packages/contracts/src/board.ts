// The workspace message board (ADR-0022 amendment 6 W10, ADR-0031 decision 10). Every current
// member of a workspace, Guests included, reads it and posts on it. A post is inert content: it
// never creates a run, task, approval or learned-memory candidate, whatever it mentions.

import type { IsoTimestamp } from "./ids.js";

export type BoardPostState = "visible" | "withdrawn" | "hidden";

/** Largest board post body, in bytes. */
export const BOARD_POST_MAX_BYTES = 16 * 1024;

/** Most posts one page of `GET /api/workspaces/:id/board` returns. */
export const BOARD_PAGE_MAX = 100;

export interface BoardPostView {
  id: string;
  workspaceId: string;
  /** The author's actor label, `user:<id>`. */
  author: string;
  authorDisplayName: string;
  body: string;
  /** `hidden` reaches only moderators (Admin or Owner); `withdrawn` reaches nobody in the list. */
  state: BoardPostState;
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Whether the caller may edit and withdraw it (its author). */
  mine: boolean;
}

/** `GET /api/workspaces/:id/board?before=<cursor>&limit=<n>`: newest first. */
export interface BoardPageView {
  posts: BoardPostView[];
  /** Pass as `before` for the next (older) page; absent on the last page. */
  nextCursor?: string;
  /** Whether the caller may hide and unhide posts here. */
  canModerate: boolean;
}

/** `POST /api/workspaces/:id/board`. */
export interface CreateBoardPostRequest {
  body: string;
  /** Idempotency key: a repeat from the same author returns the first post. */
  clientRequestId?: string;
}

/** `PATCH /api/workspaces/:id/board/:postId`: an author's edit. */
export interface EditBoardPostRequest {
  body: string;
}

/** `POST /api/workspaces/:id/board/:postId/moderate`: a moderator hides or shows a post. */
export interface ModerateBoardPostRequest {
  hidden: boolean;
  reason?: string;
}

export interface BoardPostVersionView {
  version: number;
  body: string;
  state: BoardPostState;
  op: "post" | "edit" | "withdraw" | "hide" | "unhide";
  changedBy: string;
  changedAt: IsoTimestamp;
  reason: string | null;
}
