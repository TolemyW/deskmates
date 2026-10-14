// The workspace message board (ADR-0022 amendment 6 W10, ADR-0031 decision 10). Every current
// member of the workspace, Guests included, reads and posts; the author edits and withdraws; an
// Admin or Owner hides and unhides. A post is inert: nothing here wakes a bot, creates a run,
// task, approval or memory candidate, whatever the body mentions. The route guard has resolved
// `:id` to a workspace the caller belongs to; a post is looked up inside that workspace, so
// another workspace's post is the uniform 404.

import {
  BOARD_PAGE_MAX,
  type BoardPageView,
  type BoardPostVersionView,
  type BoardPostView,
  DeskmatesError,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type BoardPost, BoardStore } from "../board/board-store.js";
import type { GatewayContext } from "../context.js";
import { roleAtLeast } from "./route-policy.js";
import { asRecord, optionalString } from "./validate.js";
import { workspaceRole } from "./workspace-access.js";

/** The signed-in person; a board post is always a person's (service principals are refused). */
function personOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal?.kind !== "user")
    throw new DeskmatesError("forbidden", "the board is for people", { reason: "people_only" });
  return principal.userId;
}

function encodeCursor(post: BoardPost): string {
  return Buffer.from(`${post.createdAt}|${post.id}`).toString("base64url");
}

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const [createdAt, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!createdAt || !id) throw new DeskmatesError("validation", "before is not a board cursor");
  return { createdAt, id };
}

function pageLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOARD_PAGE_MAX)
    throw new DeskmatesError("validation", `limit must be 1 to ${BOARD_PAGE_MAX}`);
  return limit;
}

export function registerBoardRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const board = new BoardStore(ctx.db);
  const canModerate = (request: FastifyRequest, workspaceId: string) => {
    const role = workspaceRole(ctx, request, workspaceId);
    return role !== undefined && roleAtLeast(role, "admin");
  };
  const view = (post: BoardPost, me: string): BoardPostView => ({
    id: post.id,
    workspaceId: post.workspaceId,
    author: `user:${post.authorUserId}`,
    authorDisplayName: ctx.auth.users.getUser(post.authorUserId)?.displayName ?? "",
    body: post.body,
    state: post.state,
    version: post.version,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    mine: post.authorUserId === me,
  });
  const changed = (workspaceId: string) =>
    ctx.bus.publish({ type: "board", workspaceId: workspaceId as WorkspaceId });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/workspaces/:id/board",
    async (request): Promise<BoardPageView> => {
      const me = personOf(request);
      const workspaceId = request.params.id;
      const moderator = canModerate(request, workspaceId);
      const before = decodeCursor(request.query.before);
      const { posts, more } = board.page(workspaceId, {
        ...(before ? { before } : {}),
        limit: pageLimit(request.query.limit),
        includeHidden: moderator,
      });
      const last = posts.at(-1);
      return {
        posts: posts.map((post) => view(post, me)),
        ...(more && last ? { nextCursor: encodeCursor(last) } : {}),
        canModerate: moderator,
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/board", async (request, reply) => {
    const me = personOf(request);
    const body = asRecord(request.body);
    const clientRequestId = optionalString(body, "clientRequestId");
    if (clientRequestId !== undefined && clientRequestId.length > 200)
      throw new DeskmatesError("validation", "clientRequestId is at most 200 characters");
    const post = board.post({
      workspaceId: request.params.id,
      authorUserId: me,
      body: body.body,
      ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    });
    changed(post.workspaceId);
    return reply.code(201).send({ post: view(post, me) });
  });

  app.patch<{ Params: { id: string; postId: string } }>(
    "/api/workspaces/:id/board/:postId",
    async (request) => {
      const me = personOf(request);
      const post = board.edit(
        request.params.id,
        request.params.postId,
        me,
        asRecord(request.body).body,
      );
      changed(post.workspaceId);
      return { post: view(post, me) };
    },
  );

  app.post<{ Params: { id: string; postId: string } }>(
    "/api/workspaces/:id/board/:postId/withdraw",
    async (request) => {
      const me = personOf(request);
      const post = board.withdraw(request.params.id, request.params.postId, me);
      changed(post.workspaceId);
      return { post: view(post, me) };
    },
  );

  app.post<{ Params: { id: string; postId: string } }>(
    "/api/workspaces/:id/board/:postId/moderate",
    async (request) => {
      const me = personOf(request);
      const body = asRecord(request.body);
      if (typeof body.hidden !== "boolean")
        throw new DeskmatesError("validation", "hidden must be true or false");
      const reason = optionalString(body, "reason");
      const post = board.moderate(
        request.params.id,
        request.params.postId,
        me,
        body.hidden,
        reason,
      );
      changed(post.workspaceId);
      return { post: view(post, me) };
    },
  );

  app.get<{ Params: { id: string; postId: string } }>(
    "/api/workspaces/:id/board/:postId/history",
    async (request): Promise<{ versions: BoardPostVersionView[] }> => {
      const me = personOf(request);
      const post = board.mustGet(request.params.id, request.params.postId);
      // The author and moderators read a post's history; others get the uniform 404.
      if (post.authorUserId !== me && !canModerate(request, post.workspaceId))
        throw new DeskmatesError("not_found", "Not found");
      return {
        versions: board.history(post.id).map((version) => ({
          version: version.version,
          body: version.body,
          state: version.state,
          op: version.op,
          changedBy: `user:${version.changedByUserId}`,
          changedAt: version.changedAt,
          reason: version.reason,
        })),
      };
    },
  );
}
