// T1: a Member's private chat is theirs alone (ADR-0022 amendment 6 W7, ADR-0031 decision 9).
// Another Member, an Admin, the Owner, the root and the operator credential get the uniform 404
// for its thread, messages, activity, runs, run events and approvals, lists leave it out, and
// their live streams never carry it; its person reads all of it.

import type { ApprovalId, BotId, RunId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserJar } from "../test-support/browser-session.js";
import { FAST_AUTH } from "../test-support/browser-session.js";
import { type Harness, TEST_OPERATOR_TOKEN, startHarness } from "../test-support/harness.js";
import { seedRoles, streamText } from "../test-support/roles.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("private chats (ADR-0022 amendment 6 W7)", () => {
  it("only its person reads a private chat, its runs and its approvals; lists and streams leave it out", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const harness = h;
    const { ctx } = harness.app.deskmates;
    const people = await seedRoles(harness);
    const opened = await people.member.json<{ thread: { id: string; privateToUserId?: string } }>(
      "POST",
      "/api/threads",
      { body: { workspaceId: people.workspace.id, botIds: [people.bot.id] } },
    );
    expect(opened.status).toBe(201);
    const threadId = opened.json.thread.id;
    expect(opened.json.thread.privateToUserId).toBe(people.ids.mel);
    const posted = await people.member.json<{ runs: Array<{ id: string }> }>(
      "POST",
      `/api/threads/${threadId}/messages`,
      { body: { body: "my secret question" } },
    );
    expect(posted.status, JSON.stringify(posted.json)).toBe(201);
    const runId = posted.json.runs[0]?.id as string;
    expect(runId).toBeDefined();
    const approvalId = "apr_private_audience" as ApprovalId;
    ctx.approvals.create({
      id: approvalId,
      runId: runId as RunId,
      botId: people.bot.id as BotId,
      threadId: threadId as never,
      action: { toolName: "Bash", input: { command: "echo secret" } },
      riskLevel: "L2",
    });

    const detailPaths = [
      `/api/threads/${threadId}`,
      `/api/threads/${threadId}/messages`,
      `/api/threads/${threadId}/activity`,
      `/api/runs/${runId}`,
      `/api/runs/${runId}/events`,
      `/api/runs/${runId}/context`,
      `/api/runs?threadId=${threadId}`,
      `/api/approvals/${approvalId}`,
    ];
    const others: Array<[string, BrowserJar]> = [
      ["another Member", people.otherMember],
      ["an Admin", people.admin],
      ["the Owner", people.owner],
      ["the root", people.root],
    ];
    for (const [who, jar] of others) {
      for (const path of detailPaths)
        expect((await jar.fetch("GET", path)).status, `${who} GET ${path}`).toBe(404);
      const posting = await jar.fetch("POST", `/api/threads/${threadId}/messages`, {
        body: { body: "let me in" },
      });
      expect(posting.status, `${who} posts`).toBe(404);
      const decide = await jar.fetch("POST", `/api/approvals/${approvalId}/decide`, {
        body: { decision: "allow_once" },
      });
      expect(decide.status, `${who} decides`).toBe(404);
      for (const list of ["/api/threads", "/api/runs", "/api/approvals"]) {
        const text = await (await jar.fetch("GET", list)).text();
        expect(text, `${who} ${list}`).not.toContain(threadId);
        expect(text, `${who} ${list}`).not.toContain(runId);
        expect(text, `${who} ${list}`).not.toContain("my secret question");
      }
    }
    // The operator credential is not the person either.
    const operator = (path: string) =>
      fetch(`${harness.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
      });
    for (const path of detailPaths) expect((await operator(path)).status, path).toBe(404);
    expect(await (await operator("/api/threads")).text()).not.toContain(threadId);

    // Its person reads everything.
    for (const path of detailPaths)
      expect((await people.member.fetch("GET", path)).status, `person ${path}`).toBe(200);
    const mine = await (await people.member.fetch("GET", "/api/threads")).text();
    expect(mine).toContain(threadId);
    expect(await (await people.member.fetch("GET", "/api/approvals")).text()).toContain(approvalId);

    // Live streams: the Admin's never carries the private message; the person's does.
    const post = async () => {
      const again = await people.member.fetch("POST", `/api/threads/${threadId}/messages`, {
        body: { body: "second secret" },
      });
      expect(again.status).toBe(201);
    };
    const adminStream = await streamText(harness, people.admin, post);
    expect(adminStream).not.toContain("second secret");
    expect(adminStream).not.toContain(threadId);
    const ownStream = await streamText(harness, people.member, async () => {
      const third = await people.member.fetch("POST", `/api/threads/${threadId}/messages`, {
        body: { body: "third secret" },
      });
      expect(third.status).toBe(201);
    });
    expect(ownStream).toContain("third secret");
  });

  it("a guessed id of a private chat is the same 404 as a missing one", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const people = await seedRoles(h);
    const opened = await people.member.json<{ thread: { id: string } }>("POST", "/api/threads", {
      body: { workspaceId: people.workspace.id, botIds: [people.bot.id] },
    });
    const guessed = await people.admin.json(
      "GET",
      `/api/threads/${opened.json.thread.id}/messages`,
    );
    const missing = await people.admin.json("GET", "/api/threads/thr_missing/messages");
    expect(guessed.status).toBe(404);
    expect(guessed.json).toEqual(missing.json);
  });
});
