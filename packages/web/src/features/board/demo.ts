// Demo routes of the message board (ADR-0022 amendment 6 W10): a few notes in the first
// workspace, posting with a request id that makes a retry return the first post, author edits
// and withdrawal, and moderation by the demo operator (an Owner). Demo data only. Ids come from
// this feature's own counter, so the shared seed ids of other features never move.

import type { BoardPostVersionView, BoardPostView, WorkspaceId } from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, minutesAgo } from "../../demo/state.js";

interface BoardStore {
  seq: number;
  posts: BoardPostView[];
  versions: Map<string, BoardPostVersionView[]>;
  requests: Map<string, string>;
}

const ME = "user:usr_demo";

const store = (s: DemoState): BoardStore =>
  s.store("board", () => {
    const st: BoardStore = { seq: 0, posts: [], versions: new Map(), requests: new Map() };
    const workspaceId = s.workspaces[0]?.id;
    if (workspaceId === undefined) return st;
    const seeds: [string, string, string, number][] = [
      [
        "user:usr_alex",
        "Alex Chen",
        "Reminder: the KPI dashboard moves to the new host on Friday.",
        240,
      ],
      [
        "user:usr_maya",
        "Maya Patel",
        "I left the March ticket export in shared files.\nAsk me if a column is missing.",
        90,
      ],
      [
        ME,
        "Demo operator",
        "Welcome to the board. Everyone in this workspace reads it, Guests included.",
        30,
      ],
    ];
    for (const [author, name, body, minutes] of seeds) {
      const at = minutesAgo(minutes);
      add(st, {
        id: `bp_demo_${++st.seq}`,
        workspaceId,
        author,
        authorDisplayName: name,
        body,
        state: "visible",
        version: 1,
        createdAt: at,
        updatedAt: at,
        mine: author === ME,
      });
    }
    return st;
  });

function add(st: BoardStore, post: BoardPostView): void {
  st.posts.unshift(post);
  st.versions.set(post.id, [version(post, "post")]);
}

function version(post: BoardPostView, op: BoardPostVersionView["op"]): BoardPostVersionView {
  return {
    version: post.version,
    body: post.body,
    state: post.state,
    op,
    changedBy: ME,
    changedAt: post.updatedAt,
    reason: null,
  };
}

export const demo: DemoFeature = { route };

const invalid = (message: string, status = 400): Result => ({
  status,
  json: { code: "validation", message, details: {} },
});

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, body: b } = req;
  const x = req.match(
    /^\/api\/workspaces\/([^/]+)\/board(?:\/([^/]+)(?:\/(withdraw|moderate|history))?)?$/,
  );
  if (!x) return undefined;
  const workspaceId = decodeURIComponent(x[1] ?? "");
  if (!s.workspaces.some((ws) => ws.id === workspaceId)) return notFound("workspace");
  const st = store(s);
  const postId = x[2] ? decodeURIComponent(x[2]) : undefined;
  const action = x[3];
  const changed = (post: BoardPostView, op: BoardPostVersionView["op"]): Result => {
    post.version += 1;
    post.updatedAt = new Date().toISOString();
    st.versions.get(post.id)?.push(version(post, op));
    s.emit({ type: "board", workspaceId: post.workspaceId as WorkspaceId });
    return ok({ post });
  };

  if (postId === undefined) {
    if (method === "GET") {
      const listed = st.posts.filter(
        (p) => p.workspaceId === workspaceId && p.state !== "withdrawn",
      );
      const limit = Math.min(Math.max(Number(req.query.get("limit")) || 50, 1), 100);
      const before = req.query.get("before");
      const start = before ? listed.findIndex((p) => p.id === before) + 1 : 0;
      const page = listed.slice(start, start + limit);
      const last = page.at(-1);
      return ok({
        posts: page,
        ...(start + limit < listed.length && last ? { nextCursor: last.id } : {}),
        canModerate: true,
      });
    }
    if (method === "POST") {
      const body = typeof b.body === "string" ? b.body.trim() : "";
      if (!body) return invalid("Write something to post.");
      const requestId = typeof b.clientRequestId === "string" ? b.clientRequestId : undefined;
      const repeated = requestId ? st.requests.get(requestId) : undefined;
      const first = repeated ? st.posts.find((p) => p.id === repeated) : undefined;
      if (first) return created({ post: first });
      const at = new Date().toISOString();
      const post: BoardPostView = {
        id: `bp_demo_${++st.seq}`,
        workspaceId,
        author: ME,
        authorDisplayName: "Demo operator",
        body,
        state: "visible",
        version: 1,
        createdAt: at,
        updatedAt: at,
        mine: true,
      };
      add(st, post);
      if (requestId) st.requests.set(requestId, post.id);
      s.emit({ type: "board", workspaceId: workspaceId as WorkspaceId });
      return created({ post });
    }
    return undefined;
  }

  const post = st.posts.find((p) => p.id === postId && p.workspaceId === workspaceId);
  if (!post || post.state === "withdrawn") return notFound("post");
  if (action === "history" && method === "GET")
    return ok({ versions: st.versions.get(post.id) ?? [] });
  if (action === undefined && method === "PATCH") {
    if (!post.mine) return invalid("Only the author edits a post.", 403);
    const body = typeof b.body === "string" ? b.body.trim() : "";
    if (!body) return invalid("Write something to post.");
    post.body = body;
    return changed(post, "edit");
  }
  if (action === "withdraw" && method === "POST") {
    if (!post.mine) return invalid("Only the author withdraws a post.", 403);
    post.state = "withdrawn";
    return changed(post, "withdraw");
  }
  if (action === "moderate" && method === "POST") {
    if (typeof b.hidden !== "boolean") return invalid("Say whether to hide the post.");
    post.state = b.hidden ? "hidden" : "visible";
    return changed(post, b.hidden ? "hide" : "unhide");
  }
  return undefined;
}
