// T1: the two channel-agnostic facts a chat channel adapter needs from the Gateway (ADR-0017
// decision 2): a thread bound to an external conversation by (channel, externalKey), and an
// idempotent human post keyed by externalId. The request sequence here is exactly what the
// WhatsApp adapter in packages/channels sends.

import type { Run, Thread, ThreadMember, ThreadMessage } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

type ThreadResponse = { thread: Thread; members: ThreadMember[] };
type PostResponse = { message: ThreadMessage; runs: Run[]; duplicate?: boolean };

describe("thread channel bindings", () => {
  it("creates a bound thread once and returns the same thread for the same key", async () => {
    const { workspace, bot } = await h.seed();
    const body = {
      workspaceId: workspace.id,
      botIds: [bot.id],
      channel: "whatsapp",
      externalKey: "100200:8613800000000",
      title: "WhatsApp 8613800000000",
    };
    const first = await h.api<ThreadResponse>("POST", "/api/threads", body);
    expect(first.status).toBe(201);
    expect(first.json.thread).toMatchObject({
      channel: "whatsapp",
      externalKey: "100200:8613800000000",
      kind: "chat",
      title: "WhatsApp 8613800000000",
    });

    const again = await h.api<ThreadResponse>("POST", "/api/threads", body);
    expect(again.status).toBe(200);
    expect(again.json.thread.id).toBe(first.json.thread.id);

    const found = await h.api<{ threads: Thread[] }>(
      "GET",
      "/api/threads?channel=whatsapp&externalKey=100200%3A8613800000000",
    );
    expect(found.json.threads.map((t) => t.id)).toEqual([first.json.thread.id]);

    const other = await h.api<{ threads: Thread[] }>(
      "GET",
      "/api/threads?channel=whatsapp&externalKey=100200%3A8613800000001",
    );
    expect(other.json.threads).toEqual([]);

    // The operator UI's own threads carry no key and default to the web channel.
    const web = await h.api<{ threads: Thread[] }>("GET", "/api/threads?channel=web");
    expect(web.json.threads).toHaveLength(1);
    expect(web.json.threads[0]?.externalKey).toBeUndefined();
  });

  it("rejects malformed channel names and keys", async () => {
    const { workspace, bot } = await h.seed();
    for (const extra of [
      { channel: "WhatsApp" },
      { channel: "1abc" },
      { channel: "whatsapp", externalKey: "" },
      { channel: "whatsapp", externalKey: "bad\u0000key" },
      { channel: "whatsapp", externalKey: "x".repeat(201) },
    ]) {
      const res = await h.api<{ code: string }>("POST", "/api/threads", {
        workspaceId: workspace.id,
        botIds: [bot.id],
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json.code).toBe("validation");
    }
    const query = await h.api<{ code: string }>("GET", "/api/threads?externalKey=k");
    expect(query.status).toBe(400);
  });
});

describe("idempotent human posts", () => {
  it("stores one message and wakes once for a redelivered externalId", async () => {
    const { thread, bot } = await h.seed();
    const post = () =>
      h.api<PostResponse>("POST", `/api/threads/${thread.id}/messages`, {
        body: `@${bot.name} please check the dashboard`,
        authorId: "whatsapp:8613800000000",
        externalId: "wamid.HBgLODYxMzgwMDAwMDAwMBUCABIYFjNFQjBDMUM3QzU4QjI4QjQ4RjYyRTkA",
      });
    const first = await post();
    expect(first.status).toBe(201);
    expect(first.json.duplicate).toBeUndefined();
    expect(first.json.runs).toHaveLength(1);
    expect(first.json.message).toMatchObject({
      authorKind: "human",
      authorId: "whatsapp:8613800000000",
      externalId: "wamid.HBgLODYxMzgwMDAwMDAwMBUCABIYFjNFQjBDMUM3QzU4QjI4QjQ4RjYyRTkA",
      mentions: [{ kind: "bot", botId: bot.id }],
    });

    const second = await post();
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.message.id).toBe(first.json.message.id);
    expect(second.json.runs).toEqual([]);

    const messages = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    expect(messages.json.messages).toHaveLength(1);
    const runs = await h.api<{ runs: Run[] }>("GET", `/api/runs?threadId=${thread.id}`);
    expect(runs.json.runs).toHaveLength(1);
  });

  it("keeps externalId scoped to the thread", async () => {
    const { workspace, bot, thread } = await h.seed();
    const other = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [bot.id],
    });
    const a = await h.api<PostResponse>("POST", `/api/threads/${thread.id}/messages`, {
      body: "one",
      externalId: "wamid.same",
    });
    const b = await h.api<PostResponse>("POST", `/api/threads/${other.id}/messages`, {
      body: "two",
      externalId: "wamid.same",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.duplicate).toBeUndefined();
  });

  it("rejects an empty or oversized externalId", async () => {
    const { thread } = await h.seed();
    for (const externalId of ["", "x".repeat(201), "a\nb"]) {
      const res = await h.api<{ code: string }>("POST", `/api/threads/${thread.id}/messages`, {
        body: "hello",
        externalId,
      });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("validation");
    }
  });
});
