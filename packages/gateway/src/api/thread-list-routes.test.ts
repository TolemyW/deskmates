// `GET /api/threads` carries what a chat list shows at a glance: the member ids and the newest
// message. A client opens a bot's private chat by matching members and draws a preview without
// fetching each thread's detail.

import type { RunSummary, ThreadSummary } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

function summary(reply: string): RunSummary {
  return {
    done: "answered",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  };
}

describe("thread list summaries", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("lists member ids and the newest message of each thread", async () => {
    const { bot, thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary("Hello back, this is the reply."),
        usage: [],
      });
    });

    const empty = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(empty.status).toBe(200);
    expect(empty.json.threads.map((t) => t.id)).toEqual([thread.id]);
    expect(empty.json.threads[0]?.memberIds).toEqual([bot.id]);
    expect(empty.json.threads[0]?.lastMessage).toBeUndefined();

    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: "hi there" });
    await waitFor(
      async () => {
        const r = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
        return r.json.threads[0]?.lastMessage?.authorKind === "bot";
      },
      3000,
      "bot reply listed",
    );

    const listed = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    const last = listed.json.threads[0]?.lastMessage;
    expect(last?.authorId).toBe(bot.id);
    expect(last?.excerpt).toBe("Hello back, this is the reply.");
    expect(last?.seq).toBe(2);
  });

  // ADR-0024 decision 6, issue #29: the chat list marks the bound canonical inbox from the
  // Gateway's binding, never from member count, and listing alone binds nothing.
  it("marks only the bound canonical private chat and drops the mark when it becomes a group", async () => {
    const { workspace, bot, thread } = await h.seed();
    const list = async () =>
      (await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads")).json.threads;
    // An unbound one-member chat is not canonical yet, and listing does not adopt it.
    expect((await list()).map((t) => t.privateChatBotId)).toEqual([undefined]);
    expect((await list()).map((t) => t.privateChatBotId)).toEqual([undefined]);

    const resolved = await h.api<{ thread: { id: string } }>(
      "POST",
      `/api/bots/${bot.id}/private-chat`,
      {},
    );
    expect(resolved.json.thread.id).toBe(thread.id);
    expect((await list()).find((t) => t.id === thread.id)?.privateChatBotId).toBe(bot.id);

    const other = h.app.deskmates.ctx.bots.create({
      name: "bob",
      role: "helper",
      workspaceId: workspace.id,
    });
    await h.api("POST", `/api/threads/${thread.id}/members`, { botIds: [other.id] });
    const promoted = (await list()).find((t) => t.id === thread.id);
    expect(promoted?.memberIds).toHaveLength(2);
    expect(promoted?.privateChatBotId).toBeUndefined();

    const fresh = await h.api<{ thread: { id: string } }>(
      "POST",
      `/api/bots/${bot.id}/private-chat`,
      {},
    );
    expect(fresh.json.thread.id).not.toBe(thread.id);
    const after = await list();
    expect(after.map((t) => t.id).sort()).toEqual([thread.id, fresh.json.thread.id].sort());
    expect(after.find((t) => t.id === fresh.json.thread.id)?.privateChatBotId).toBe(bot.id);
  });

  it("caps the excerpt at 160 characters", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: summary(""),
        usage: [],
      });
    });
    const long = "x".repeat(400);
    await h.api("POST", `/api/threads/${thread.id}/messages`, { body: long });
    const listed = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(listed.json.threads[0]?.lastMessage?.excerpt).toHaveLength(160);
  });

  it("resolves a human preview author's display name", async () => {
    const { workspace, thread } = await h.seed();
    const person = await h.app.deskmates.ctx.auth.createUser({
      loginName: "olive",
      displayName: "Olive Owner",
      password: "correct horse battery staple",
      role: "member",
      workspaceId: workspace.id,
    });
    h.app.deskmates.ctx.messages.append({
      threadId: thread.id,
      authorKind: "human",
      authorId: `user:${person.id}`,
      body: "please re-run the check",
    });
    const listed = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(listed.json.threads[0]?.lastMessage).toMatchObject({
      authorId: `user:${person.id}`,
      authorName: "Olive Owner",
    });
  });

  // Issue #16: a bot reply stored before the summary parser read the one-line fence (cf21f30)
  // is the whole fenced block. The stored body stays; the preview shows the object text.
  it("previews a fenced last message as its object text, leaving the stored body as it is", async () => {
    const { bot, thread } = await h.seed();
    const fence = "```";
    const fenced = `${fence}json {"done": "checked the labels", "reply": "All labels verified."} ${fence}`;
    const stored = h.app.deskmates.ctx.messages.append({
      threadId: thread.id,
      authorKind: "bot",
      authorId: bot.id,
      body: fenced,
    });
    const listed = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(listed.json.threads[0]?.lastMessage?.excerpt).toBe(
      '{"done": "checked the labels", "reply": "All labels verified."}',
    );
    expect(h.app.deskmates.ctx.messages.mustGet(stored.id).body).toBe(fenced);

    h.app.deskmates.ctx.messages.append({
      threadId: thread.id,
      authorKind: "bot",
      authorId: bot.id,
      body: `${fence}json\n{\n  "reply": "${"长".repeat(400)}"\n}\n${fence}`,
    });
    const cut = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    const excerpt = cut.json.threads[0]?.lastMessage?.excerpt ?? "";
    expect(excerpt.startsWith('{ "reply": "长长')).toBe(true);
    expect(Array.from(excerpt)).toHaveLength(160);
  });

  it("projects linked task context without changing the conversation", async () => {
    const { workspace, thread } = await h.seed();
    const task = h.app.deskmates.ctx.tasks.create(workspace.id, {
      title: "Review the release",
      threadIds: [thread.id],
    });
    const listed = await h.api<{ threads: ThreadSummary[] }>(
      "GET",
      `/api/threads?workspaceId=${workspace.id}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.json.threads.find((item) => item.id === thread.id)?.taskContext).toEqual({
      id: task.id,
      title: task.title,
      status: task.status,
    });
  });
});
