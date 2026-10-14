// The workspace message board (ADR-0031 decision 10, issue #116): explicit posts every current
// member of the workspace reads. A post is inert content: it never creates a run, task,
// approval or learned-memory candidate, whatever it mentions. Authors edit and withdraw their
// own posts; a moderator hides and unhides. Every change adds an immutable version row. Who may
// moderate is the #116 role matrix's decision; this store takes the actor it is given.

import { DeskmatesError } from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export type BoardPostState = "visible" | "withdrawn" | "hidden";
export type BoardPostOp = "post" | "edit" | "withdraw" | "hide" | "unhide";

export const BOARD_POST_MAX_BYTES = 16 * 1024;

export interface BoardPost {
  id: string;
  workspaceId: string;
  authorUserId: string;
  body: string;
  state: BoardPostState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BoardPostVersion {
  postId: string;
  version: number;
  body: string;
  state: BoardPostState;
  op: BoardPostOp;
  changedByUserId: string;
  changedAt: string;
  reason: string | null;
}

interface PostRow {
  id: string;
  workspace_id: string;
  author_user_id: string;
  body: string;
  state: BoardPostState;
  version: number;
  created_at: string;
  updated_at: string;
}

function toPost(row: PostRow): BoardPost {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    authorUserId: row.author_user_id,
    body: row.body,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function checkedBody(body: unknown): string {
  if (typeof body !== "string" || body.trim() === "")
    throw new DeskmatesError("validation", "a board post needs a body");
  if (Buffer.byteLength(body) > BOARD_POST_MAX_BYTES)
    throw new DeskmatesError("validation", "a board post is at most 16 KiB");
  return body;
}

export class BoardStore {
  constructor(private readonly db: GatewayDb) {}

  /**
   * Post to a workspace's board. A repeated `clientRequestId` from the same author returns the
   * first post instead of a duplicate.
   */
  post(input: {
    workspaceId: string;
    authorUserId: string;
    body: unknown;
    clientRequestId?: string;
  }): BoardPost {
    const body = checkedBody(input.body);
    return this.db.transaction(() => {
      if (input.clientRequestId !== undefined) {
        const existing = this.db
          .prepare(
            "SELECT * FROM board_posts WHERE workspace_id = ? AND author_user_id = ? AND client_request_id = ?",
          )
          .get(input.workspaceId, input.authorUserId, input.clientRequestId) as PostRow | undefined;
        if (existing) return toPost(existing);
      }
      const id = newId("bpo");
      const at = nowIso();
      this.db
        .prepare(
          `INSERT INTO board_posts (id, workspace_id, author_user_id, body, state, version,
             client_request_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'visible', 1, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          input.authorUserId,
          body,
          input.clientRequestId ?? null,
          at,
          at,
        );
      this.version(id, 1, body, "visible", "post", input.authorUserId, at, null);
      return this.mustGet(input.workspaceId, id);
    })();
  }

  get(workspaceId: string, id: string): BoardPost | undefined {
    const row = this.db
      .prepare("SELECT * FROM board_posts WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as PostRow | undefined;
    return row ? toPost(row) : undefined;
  }

  mustGet(workspaceId: string, id: string): BoardPost {
    const post = this.get(workspaceId, id);
    if (!post) throw new DeskmatesError("not_found", "Not found");
    return post;
  }

  /** The visible posts, oldest first; withdrawn and hidden ones are in their history. */
  list(workspaceId: string): BoardPost[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM board_posts WHERE workspace_id = ? AND state = 'visible' ORDER BY created_at, rowid",
        )
        .all(workspaceId) as PostRow[]
    ).map(toPost);
  }

  /**
   * One page of the board, newest first (ADR-0022 amendment 6 W10): visible posts, and hidden
   * ones too for a moderator. `before` is the `(createdAt, id)` of the last post of the previous
   * page; one extra row tells whether another page follows. Posts written in the same millisecond
   * keep their insertion order (rowid), not the order of their random ids.
   */
  page(
    workspaceId: string,
    options: { before?: { createdAt: string; id: string }; limit: number; includeHidden: boolean },
  ): { posts: BoardPost[]; more: boolean } {
    const states = options.includeHidden ? "('visible', 'hidden')" : "('visible')";
    const before = options.before;
    const rows = this.db
      .prepare(
        `SELECT * FROM board_posts WHERE workspace_id = ? AND state IN ${states}
           ${before ? "AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM board_posts WHERE id = ?)))" : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        ...(before
          ? [workspaceId, before.createdAt, before.createdAt, before.id, options.limit + 1]
          : [workspaceId, options.limit + 1]),
      ) as PostRow[];
    return { posts: rows.slice(0, options.limit).map(toPost), more: rows.length > options.limit };
  }

  history(postId: string): BoardPostVersion[] {
    return (
      this.db
        .prepare("SELECT * FROM board_post_versions WHERE post_id = ? ORDER BY version")
        .all(postId) as Array<Record<string, unknown>>
    ).map((row) => ({
      postId: row.post_id as string,
      version: row.version as number,
      body: row.body as string,
      state: row.state as BoardPostState,
      op: row.op as BoardPostOp,
      changedByUserId: row.changed_by_user_id as string,
      changedAt: row.changed_at as string,
      reason: row.reason as string | null,
    }));
  }

  /** The author edits a visible post. */
  edit(workspaceId: string, id: string, byUserId: string, body: unknown): BoardPost {
    const next = checkedBody(body);
    return this.change(workspaceId, id, byUserId, "edit", (post) => {
      if (post.authorUserId !== byUserId)
        throw new DeskmatesError("forbidden", "only the author edits a post", { reason: "author" });
      if (post.state !== "visible")
        throw new DeskmatesError("invalid_transition", "only a visible post is edited");
      return { body: next, state: "visible" };
    });
  }

  /** The author withdraws their post; it stays in the history. */
  withdraw(workspaceId: string, id: string, byUserId: string): BoardPost {
    return this.change(workspaceId, id, byUserId, "withdraw", (post) => {
      if (post.authorUserId !== byUserId)
        throw new DeskmatesError("forbidden", "only the author withdraws a post", {
          reason: "author",
        });
      if (post.state === "withdrawn")
        throw new DeskmatesError("invalid_transition", "the post is already withdrawn");
      return { body: post.body, state: "withdrawn" };
    });
  }

  /** A moderator hides a post, or shows it again; reversible and attributable. */
  moderate(
    workspaceId: string,
    id: string,
    byUserId: string,
    hidden: boolean,
    reason?: string,
  ): BoardPost {
    return this.change(
      workspaceId,
      id,
      byUserId,
      hidden ? "hide" : "unhide",
      (post) => {
        if (post.state === "withdrawn")
          throw new DeskmatesError("invalid_transition", "a withdrawn post is not moderated");
        if ((post.state === "hidden") === hidden)
          throw new DeskmatesError("invalid_transition", "the post is already in that state");
        return { body: post.body, state: hidden ? "hidden" : "visible" };
      },
      reason,
    );
  }

  private change(
    workspaceId: string,
    id: string,
    byUserId: string,
    op: BoardPostOp,
    next: (post: BoardPost) => { body: string; state: BoardPostState },
    reason?: string,
  ): BoardPost {
    return this.db.transaction(() => {
      const post = this.mustGet(workspaceId, id);
      const { body, state } = next(post);
      const version = post.version + 1;
      const at = nowIso();
      this.db
        .prepare(
          "UPDATE board_posts SET body = ?, state = ?, version = ?, updated_at = ? WHERE id = ?",
        )
        .run(body, state, version, at, id);
      this.version(id, version, body, state, op, byUserId, at, reason ?? null);
      return this.mustGet(workspaceId, id);
    })();
  }

  private version(
    postId: string,
    version: number,
    body: string,
    state: BoardPostState,
    op: BoardPostOp,
    byUserId: string,
    at: string,
    reason: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO board_post_versions (post_id, version, body, state, op, changed_by_user_id,
           changed_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(postId, version, body, state, op, byUserId, at, reason);
  }
}
