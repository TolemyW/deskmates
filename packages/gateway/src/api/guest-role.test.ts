// T1: a Guest reads the workspace's shared chats and the board, posts on the board and opens a
// private status inquiry, and nothing else (ADR-0022 amendment 6 W6). A question in the inquiry
// queues a tool-free status job (amendment 7 S1), never an ordinary bot run.

import { afterEach, describe, expect, it } from "vitest";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRoles, streamText } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const runCount = (harness: Harness) =>
  (harness.app.deskmates.ctx.db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n;

describe("Guest (ADR-0022 amendment 6 W6)", () => {
  it("reads shared chats, posts in none, and reaches no execution, file, task or cost route", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const { ctx } = harness.app.deskmates;
    const people = await seedRoles(harness);
    const second = ctx.bots.create({ workspaceId: people.workspace.id, name: "second", role: "r" });
    const group = ctx.threads.create({
      workspaceId: people.workspace.id,
      botIds: [people.bot.id, second.id],
    });
    const bus = ctx.threads.create({
      workspaceId: people.workspace.id,
      botIds: [people.bot.id, second.id],
      kind: "bus",
    } as Parameters<typeof ctx.threads.create>[0]);
    expect(
      (
        await people.admin.fetch("POST", `/api/threads/${group.id}/messages`, {
          body: { body: "status: the report ships Friday" },
        })
      ).status,
    ).toBe(201);
    const runsBefore = runCount(harness);

    // Reads: the shared chat and its original text, the workspace and its bots.
    const listed = await (await people.guest.fetch("GET", "/api/threads")).text();
    expect(listed).toContain(group.id);
    expect(listed).not.toContain(bus.id);
    const messages = await people.guest.json<{ messages: Array<{ body: string }> }>(
      "GET",
      `/api/threads/${group.id}/messages`,
    );
    expect(messages.status).toBe(200);
    expect(messages.json.messages.map((m) => m.body)).toContain("status: the report ships Friday");
    expect((await people.guest.fetch("GET", `/api/threads/${bus.id}/messages`)).status).toBe(404);
    expect((await people.guest.fetch("GET", "/api/workspaces")).status).toBe(200);
    expect((await people.guest.fetch("GET", `/api/bots/${people.bot.id}`)).status).toBe(200);

    // Posts in no shared chat.
    const refused = await people.guest.json<{ details?: { reason?: string } }>(
      "POST",
      `/api/threads/${group.id}/messages`,
      { body: { body: "can I say something?" } },
    );
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("guest_read_only");

    // A private inquiry opens; a question there queues one status job, never a bot run
    // (amendment 7 S1; `status-inquiries.test.ts` covers the job).
    const inquiry = await people.guest.json<{ thread: { id: string; privateToUserId?: string } }>(
      "POST",
      "/api/threads",
      { body: { workspaceId: people.workspace.id, botIds: [people.bot.id] } },
    );
    expect(inquiry.status).toBe(201);
    expect(inquiry.json.thread.privateToUserId).toBe(people.ids.gus);
    const asked = await people.guest.json<{ runs: Array<{ id: string }> }>(
      "POST",
      `/api/threads/${inquiry.json.thread.id}/messages`,
      { body: { body: "what is the status?" } },
    );
    expect(asked.status).toBe(201);
    expect(asked.json.runs).toHaveLength(1);
    expect(
      harness.app.deskmates.ctx.runs.mustGet(asked.json.runs[0]?.id as never).config.runType,
    ).toBe("status_inquiry");
    // A group chat is not theirs to open.
    expect(
      (
        await people.guest.fetch("POST", "/api/threads", {
          body: { workspaceId: people.workspace.id, botIds: [people.bot.id, second.id] },
        })
      ).status,
    ).toBe(403);

    // Nothing of the machinery.
    const ws = people.workspace.id;
    for (const [method, path, body] of [
      ["GET", "/api/runs"],
      ["GET", "/api/approvals"],
      ["GET", "/api/costs"],
      ["GET", `/api/workspaces/${ws}/files`],
      ["GET", `/api/workspaces/${ws}/assets`],
      ["GET", `/api/workspaces/${ws}/tasks`],
      ["GET", `/api/workspaces/${ws}/memory`],
      ["GET", `/api/bots/${people.bot.id}/memory`],
      ["GET", `/api/bots/${people.bot.id}/screen`],
      ["POST", `/api/workspaces/${ws}/takeover`, {}],
      ["POST", `/api/workspaces/${ws}/submit`, { botId: people.bot.id, title: "t", body: "b" }],
      ["GET", "/api/knowledge"],
      ["GET", "/api/skills/versions"],
    ] as Array<[string, string, unknown?]>) {
      const response = await people.guest.fetch(method, path, body === undefined ? {} : { body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    // The status job is the only run a Guest's actions created.
    expect(runCount(harness)).toBe(runsBefore + 1);

    // The live stream carries the conversation, never run events.
    const text = await streamText(harness, people.guest, async () => {
      const posted = await people.admin.fetch("POST", `/api/threads/${group.id}/messages`, {
        body: { body: "update for everyone" },
      });
      expect(posted.status).toBe(201);
    });
    expect(text).toContain("update for everyone");
    expect(text).not.toContain("event: run_status");
    expect(text).not.toContain("event: run_event");
  });
});
