// T1: a must-reply message (issue #21, decision 3). A run woken by one that ends `silent` is
// recorded `failed` with reason `no_reply`; a run that replies is unchanged, and routing is the
// same as for any other message.

import { RUN_ERROR_NO_REPLY, type ThreadMessage } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function endWith(reply: string): Parameters<Harness["provider"]["onRun"]>[0] {
  return async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "done",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply,
      },
      usage: [],
    });
  };
}

async function settled(runId: string): Promise<RunRecord> {
  const runs = h.app.deskmates.ctx.runs;
  await waitFor(
    () => ["succeeded", "silent", "failed"].includes(runs.mustGet(runId as RunRecord["id"]).status),
    3000,
    "run end",
  );
  return runs.mustGet(runId as RunRecord["id"]);
}

describe("must_reply on a posted message", () => {
  it("is stored on the message and returned by the transcript; absent by default", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith("ok"));
    const flagged = await h.api<{ message: ThreadMessage; runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "answer this", mustReply: true },
    );
    expect(flagged.status).toBe(201);
    expect(flagged.json.message.mustReply).toBe(true);
    await settled(flagged.json.runs[0]?.id as string);
    const plain = await h.api<{ message: ThreadMessage; runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "no need" },
    );
    expect(plain.json.message.mustReply).toBeUndefined();
    await settled(plain.json.runs[0]?.id as string);
    const listed = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${thread.id}/messages`,
    );
    const human = listed.json.messages.filter((m) => m.authorKind === "human");
    expect(human.map((m) => m.mustReply)).toEqual([true, undefined]);
  });

  it("refuses a mustReply that is not a boolean", async () => {
    const { thread } = await h.seed();
    const res = await h.api<{ code: string }>("POST", `/api/threads/${thread.id}/messages`, {
      body: "x",
      mustReply: "yes",
    });
    expect(res.status).toBe(400);
    expect(h.app.deskmates.ctx.messages.list(thread.id)).toHaveLength(0);
  });
});

describe("the end of a run woken by a must-reply message", () => {
  it("records a silent end as failed with reason no_reply", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith(""));
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "answer this", mustReply: true },
    );
    const run = await settled(posted.json.runs[0]?.id as string);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(RUN_ERROR_NO_REPLY);
    expect(run.config.mustReply).toBe(true);
    // The run saw the message: a later wake is not handed it again.
    const member = h.app.deskmates.ctx.threads.member(thread.id, run.botId);
    expect(member?.lastSeenSeq).toBe(1);
    const detail = await h.api<{ run: RunRecord }>("GET", `/api/runs/${run.id}`);
    expect(detail.json.run.error).toBe(RUN_ERROR_NO_REPLY);
  });

  it("leaves a run that replied unchanged", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith("here is the answer"));
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "answer this", mustReply: true },
    );
    const run = await settled(posted.json.runs[0]?.id as string);
    expect(run.status).toBe("succeeded");
    expect(run.error).toBeUndefined();
  });

  it("counts a thread_post during the run as the reply", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("messages", {
        type: "post_message",
        runId: req.runId,
        tool: "thread_post",
        body: "answered mid-run",
      });
      await endWith("")(req, gw);
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "answer this", mustReply: true },
    );
    const run = await settled(posted.json.runs[0]?.id as string);
    // It posted, so it is neither `no_reply` nor silent (owner definition, 2026-10-17).
    expect(run.status).toBe("succeeded");
  });

  it("keeps a silent end silent when no delivered message asked for a reply", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(endWith(""));
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "fyi" },
    );
    const run = await settled(posted.json.runs[0]?.id as string);
    expect(run.status).toBe("silent");
    expect(run.config.mustReply).toBeUndefined();
  });

  it("wakes exactly the members an ordinary message would", async () => {
    const { workspace, bot } = await h.seed();
    const second = await h.api<{ bot: { id: string } }>("POST", "/api/bots", {
      name: "bob",
      role: "helper",
      workspaceId: workspace.id,
    });
    const group = await h.api<{ thread: { id: string } }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id, second.json.bot.id],
    });
    h.provider.onRun(endWith(""));
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${group.json.thread.id}/messages`,
      { body: "@bob please answer", mustReply: true },
    );
    expect(posted.json.runs.map((r) => r.botId)).toEqual([second.json.bot.id]);
    const run = await settled(posted.json.runs[0]?.id as string);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(RUN_ERROR_NO_REPLY);
  });
});
