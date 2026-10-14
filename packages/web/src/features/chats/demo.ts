// Demo routes of Chats: thread lists and detail, new chats, membership, canonical private chats
// (ADR-0024 decision 6), messages that wake the scripted team, and closing a task into an
// episode. The seeded chats themselves are the core history (src/demo/core-seed.ts).

import {
  type BotId,
  type RoundMemberState,
  type RunStatus,
  type ThreadId,
  type ThreadRound,
  type WorkspaceId,
  isRoundMemberDone,
} from "@deskmates/contracts";
import type { GatewayEvent } from "../../api/types.js";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";
import { recipients, wake } from "../../demo/team.js";

export const demo: DemoFeature = { route };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/threads" && method === "GET") {
    const ws = q.get("workspaceId");
    return ok({
      threads: s.threads.filter((t) => !ws || t.workspaceId === ws).map((t) => s.summarize(t)),
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/private-chat$/)) && method === "POST") {
    const bot = s.bots.find((bot) => bot.id === decodeURIComponent(x?.[1] ?? ""));
    if (!bot) return notFound("bot");
    // ADR-0024 decision 6 as the Gateway does it: a bound inbox is reused; with no binding
    // yet the newest one-member web chat is adopted once; a cleared binding (the inbox became
    // a group) gets a fresh chat.
    const bound = s.privateChats.get(bot.id);
    const adopted =
      bound === undefined
        ? [...s.threads]
            .filter(
              (t) =>
                t.workspaceId === bot.workspaceId &&
                t.kind === "chat" &&
                t.channel === "web" &&
                (s.members.get(t.id) ?? []).length === 1 &&
                s.members.get(t.id)?.[0] === bot.id,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]
        : undefined;
    const thread =
      (bound ? s.thread(bound) : undefined) ??
      adopted ??
      s.addThread(bot.workspaceId, [bot.id], "", "chat");
    s.privateChats.set(bot.id, thread.id);
    return ok(s.detail(thread));
  }
  // The demo does not execute private handoffs; the real Gateway owns this activity.
  if (/^\/api\/threads\/[^/]+\/activity$/.test(path) && method === "GET")
    return ok({ handoffs: [] });
  // Request rounds (ADR-0005 amendment 4), derived from the runs each human message woke.
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)\/rounds$/)) && method === "GET") {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    return ok({ rounds: demoRounds(s, thread.id) });
  }
  if (/^\/api\/threads\/[^/]+\/rounds\/[^/]+\/(cancel|members\/[^/]+\/retry)$/.test(path))
    return ok({});
  if (path === "/api/threads" && method === "POST") {
    const thread = s.addThread(
      b.workspaceId as WorkspaceId,
      (b.botIds as BotId[]) ?? [],
      typeof b.title === "string" ? b.title : "",
      "chat",
    );
    return created({ thread, members: s.namedMembers(thread.id) });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)$/))) {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    return ok(s.detail(thread));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)\/members$/)) && method === "POST") {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    const list = s.members.get(thread.id) ?? [];
    for (const botId of (b.botIds as BotId[]) ?? []) if (!list.includes(botId)) list.push(botId);
    s.members.set(thread.id, list);
    if (list.length !== 1) s.unbindPrivateChat(thread.id);
    s.emit({ type: "thread_members", threadId: thread.id } as GatewayEvent);
    return ok(s.detail(thread));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)\/members\/([^/]+)$/)) && method === "DELETE") {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    const botId = decodeURIComponent(x[2] ?? "") as BotId;
    if (s.privateChats.get(botId) === thread.id) s.privateChats.set(botId, null);
    s.members.set(
      thread.id,
      (s.members.get(thread.id) ?? []).filter((m) => m !== botId),
    );
    s.emit({ type: "thread_members", threadId: thread.id } as GatewayEvent);
    return ok(s.detail(thread));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)\/messages$/))) {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    if (method === "POST") {
      const message = s.post(thread, "human", "operator", String(b.body ?? ""));
      if (thread.status === "paused") thread.status = "active";
      const runs = wake(s, thread, message, recipients(s, thread, message.body, undefined), 0);
      return created({ message, runs });
    }
    const after = Number(q.get("afterSeq") ?? 0);
    return ok({
      messages: (s.messages.get(thread.id) ?? []).filter((msg) => msg.seq > after),
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/threads\/([^/]+)\/close-task$/))) {
    const thread = s.thread(x[1]);
    if (!thread) return notFound("thread");
    const notes = s.memory.filter(
      (e) => e.scope === "task" && e.threadId === thread.id && !e.episodeId && !e.tombstoned,
    );
    if (notes.length === 0) return ok({ episode: null, distilled: [] });
    const episode = s.addMemory({
      scope: "task",
      kind: "episode",
      threadId: thread.id,
      body: `Episode of "${thread.title}": ${notes.map((n) => n.body).join(" ")}`,
      authority: "fact",
      trust: "trusted",
      sourceKind: "bot_self",
      derivedFrom: notes.map((n) => n.id),
    });
    for (const n of notes) n.episodeId = episode.id;
    return ok({ episode, distilled: notes.map((n) => n.body) });
  }

  return undefined;
}

const DEMO_STATE: Readonly<Partial<Record<RunStatus, RoundMemberState>>> = {
  queued: "queued",
  running: "running",
  waiting_browser: "running",
  waiting_approval: "awaiting_approval",
  waiting_approval_live: "awaiting_approval",
  waiting_continuation: "paused",
  succeeded: "replied",
  silent: "silent",
  failed: "failed",
  cancelled: "cancelled",
  stopped: "stopped",
};

function demoRounds(s: DemoState, threadId: ThreadId): ThreadRound[] {
  const messages = (s.messages.get(threadId) ?? []).filter((msg) => msg.authorKind === "human");
  return messages
    .slice(-10)
    .reverse()
    .map((message) => {
      const runs = [...s.runs.values()].filter((run) => run.triggerRef === message.id);
      const members = runs.map((run, ordinal) => ({
        botId: run.botId,
        ordinal,
        state: DEMO_STATE[run.status] ?? "pending",
        runId: run.id,
        runs: [{ runId: run.id, relation: "created" as const }],
        outputMessageIds: [],
      }));
      return {
        workspaceId: s.thread(threadId)?.workspaceId as WorkspaceId,
        threadId,
        messageId: message.id,
        messageSeq: message.seq,
        authorKind: "human" as const,
        authorId: message.authorId,
        excerpt: message.body.slice(0, 140),
        mode: "parallel" as const,
        createdAt: message.ts,
        members,
        completed: members.filter((m) => isRoundMemberDone(m.state)).length,
        total: members.length,
      };
    })
    .filter((round) => round.total > 0);
}
