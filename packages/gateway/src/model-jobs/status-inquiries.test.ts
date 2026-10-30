// T1, ADR-0022 amendment 7 S1 to S4: a Guest's question in their own private inquiry is stored
// and answered by one tool-free model job of the inquiry's bot, fed with a projection of what the
// Guest may read; the answer is the Guest's alone and the job is never an ordinary bot run.

import type {
  BotDefinition,
  StartRunRequest,
  ThreadMessage,
  Workspace,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../board/board-store.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { streamText } from "../test-support/roles.js";
import { NO_STATUS_ANSWER, STATUS_INQUIRY } from "./status-inquiries.js";

let h: Harness | undefined;
const jobs: StartRunRequest[] = [];
let answer = "Friday, per the Release chat.";
let gate: Promise<void> = Promise.resolve();

afterEach(async () => {
  await h?.close();
  h = undefined;
  jobs.length = 0;
  answer = "Friday, per the Release chat.";
  gate = Promise.resolve();
});

async function play(request: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  jobs.push(request);
  await gate;
  await gw.post("ended", {
    type: "run_ended",
    runId: request.runId,
    outcome: answer ? "completed" : "failed",
    ...(answer
      ? {
          summary: {
            done: "Status answer",
            reply: answer,
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
          },
        }
      : { error: "model unavailable" }),
    usage: [
      {
        model: request.model,
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    ],
  });
}

interface Fixture {
  harness: Harness;
  workspace: Workspace;
  bot: BotDefinition;
  ids: Record<string, string>;
  root: BrowserJar;
  owner: BrowserJar;
  admin: BrowserJar;
  member: BrowserJar;
  guest: BrowserJar;
}

/** One workspace with a bot and a signed-in person per role; the scheduler stays running. */
async function seed(): Promise<Fixture> {
  h = await startHarness({ auth: FAST_AUTH });
  const harness = h;
  harness.provider.onRun(play);
  const { ctx } = harness.app.deskmates;
  const rootUser = await createOwner(ctx.auth, {
    loginName: "admin",
    displayName: "Root",
    password: TEST_PASSWORD,
  });
  const workspace = ctx.workspaces.create({ name: "W", sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name: "helper", role: "keeps release" });
  const ids: Record<string, string> = { admin: rootUser.id };
  for (const [loginName, role] of [
    ["oona", "owner"],
    ["ada", "admin"],
    ["mel", "member"],
    ["gus", "guest"],
  ] as const)
    ids[loginName] = (
      await ctx.auth.createUser({
        loginName,
        displayName: loginName,
        password: TEST_PASSWORD,
        role,
        workspaceId: workspace.id,
      })
    ).id;
  const signedIn = async (loginName: string) => {
    const jar = new BrowserJar(harness.baseUrl);
    if ((await jar.signIn(loginName)).status !== 200) throw new Error(`${loginName} signed out`);
    return jar;
  };
  return {
    harness,
    workspace,
    bot,
    ids,
    root: await signedIn("admin"),
    owner: await signedIn("oona"),
    admin: await signedIn("ada"),
    member: await signedIn("mel"),
    guest: await signedIn("gus"),
  };
}

async function openInquiry(f: Fixture): Promise<string> {
  const opened = await f.guest.json<{ thread: { id: string } }>("POST", "/api/threads", {
    body: { workspaceId: f.workspace.id, botIds: [f.bot.id] },
  });
  expect(opened.status).toBe(201);
  return opened.json.thread.id;
}

async function messagesOf(jar: BrowserJar, threadId: string): Promise<ThreadMessage[]> {
  return (await jar.json<{ messages: ThreadMessage[] }>("GET", `/api/threads/${threadId}/messages`))
    .json.messages;
}

const runRows = (f: Fixture) =>
  f.harness.app.deskmates.ctx.db.prepare("SELECT id, config_json FROM runs").all() as Array<{
    id: string;
    config_json: string;
  }>;

describe("Guest status inquiries (ADR-0022 amendment 7)", () => {
  it("a Guest's question is answered by one tool-free job attached to the inquiry (S1)", async () => {
    const f = await seed();
    const { ctx } = f.harness.app.deskmates;
    // The bot's own models are not the job's: it runs on the default model (owner, 2026-10-14).
    ctx.bots.update(f.bot.id, { model: "bot-own-model", cheapModel: "bot-own-cheap" });
    const inquiry = await openInquiry(f);
    const asked = await f.guest.json<{ runs: Array<{ id: string; lane: string }> }>(
      "POST",
      `/api/threads/${inquiry}/messages`,
      { body: { body: "when does the report ship?" } },
    );
    expect(asked.status).toBe(201);
    expect(asked.json.runs).toHaveLength(1);
    const runId = asked.json.runs[0]?.id as string;
    await waitFor(
      async () => (await messagesOf(f.guest, inquiry)).some((m) => m.authorKind === "bot"),
      3000,
      "status answer appended",
    );
    const messages = await messagesOf(f.guest, inquiry);
    expect(messages.map((m) => [m.authorKind, m.body])).toEqual([
      ["human", "when does the report ship?"],
      ["bot", "Friday, per the Release chat."],
    ]);
    expect(messages[1]?.runId).toBe(runId);
    expect(messages[1]?.authorId).toBe(f.bot.id);

    // One job, as a model job: no session, the default model, the question as its input.
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as StartRunRequest;
    expect(job.modelJob).toMatchObject({
      kind: "status_inquiry",
      botName: "helper",
      question: "when does the report ship?",
    });
    expect(job.sdkSessionId).toBeUndefined();
    expect(job.model).toBe(ctx.config.defaultModel);
    expect(job.model).not.toBe(ctx.config.cheapModel);
    // The background lane: a person's chat with the bot is never held by a Guest's question.
    const run = ctx.runs.mustGet(runId as never);
    expect(run).toMatchObject({
      threadId: inquiry,
      lane: "background",
      triggerKind: "model_job",
      status: "succeeded",
    });
    expect(run.config).toMatchObject({
      runType: STATUS_INQUIRY,
      requestedBy: `user:${f.ids.gus}`,
      maxTurns: 1,
      model: ctx.config.defaultModel,
    });
    // No ordinary bot run, round or session came of it.
    expect(runRows(f)).toHaveLength(1);
    expect(ctx.sessions.get(f.bot.id, inquiry as never)).toBeUndefined();
    expect(
      (
        ctx.db.prepare("SELECT count(*) AS n FROM run_usage WHERE run_id = ?").get(runId) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("the projection holds what a Guest may read and nothing else (S2)", async () => {
    const f = await seed();
    const { ctx } = f.harness.app.deskmates;
    const second = ctx.bots.create({ workspaceId: f.workspace.id, name: "second", role: "r" });
    const group = ctx.threads.create({
      workspaceId: f.workspace.id,
      botIds: [f.bot.id, second.id],
      title: "Release",
    });
    ctx.messages.append({
      threadId: group.id,
      authorKind: "human",
      authorId: `user:${f.ids.ada}`,
      body: "the report ships Friday",
    });
    const bus = ctx.threads.create({
      workspaceId: f.workspace.id,
      botIds: [f.bot.id, second.id],
      kind: "bus",
    } as Parameters<typeof ctx.threads.create>[0]);
    ctx.messages.append({
      threadId: bus.id,
      authorKind: "bot",
      authorId: second.id,
      body: "bus chatter between bots",
    });
    const privateChat = await f.member.json<{ thread: { id: string } }>("POST", "/api/threads", {
      body: { workspaceId: f.workspace.id, botIds: [f.bot.id] },
    });
    ctx.messages.append({
      threadId: privateChat.json.thread.id as never,
      authorKind: "human",
      authorId: `user:${f.ids.mel}`,
      body: "a member's private plan",
    });
    const board = new BoardStore(ctx.db);
    board.post({
      workspaceId: f.workspace.id,
      authorUserId: f.ids.gus as string,
      body: "board hello",
    });
    const hidden = board.post({
      workspaceId: f.workspace.id,
      authorUserId: f.ids.gus as string,
      body: "a hidden note",
    });
    board.moderate(f.workspace.id, hidden.id, f.ids.ada as string, true);
    const inquiry = await openInquiry(f);
    await f.guest.fetch("POST", `/api/threads/${inquiry}/messages`, { body: { body: "status?" } });
    await waitFor(async () => jobs.length === 1, 3000, "job started");
    const job = jobs[0]?.modelJob;
    const projection = job?.kind === "status_inquiry" ? job.projection : "";
    expect(projection).toContain("Workspace: W");
    expect(projection).toContain("- helper: keeps release");
    expect(projection).toContain("Release");
    expect(projection).toContain("the report ships Friday");
    expect(projection).toContain("board hello");
    for (const absent of [
      "bus chatter between bots",
      "a member's private plan",
      "a hidden note",
      "status?",
      "succeeded",
      "SOUL",
    ])
      expect(projection, absent).not.toContain(absent);
  });

  it("the projection carries task status and progress (S2, owner 2026-10-14)", async () => {
    const f = await seed();
    const { ctx } = f.harness.app.deskmates;
    const ws = f.workspace.id;
    const shared = ctx.threads.create({ workspaceId: ws, botIds: [f.bot.id], title: "Ops" });
    const privateChat = await f.member.json<{ thread: { id: string } }>("POST", "/api/threads", {
      body: { workspaceId: ws, botIds: [f.bot.id] },
    });
    const privateId = privateChat.json.thread.id;
    const report = ctx.tasks.create(ws, {
      title: "Quarterly report",
      description: "secret description text",
      ownerBotId: f.bot.id,
      threadIds: [shared.id],
    });
    const blocked = ctx.tasks.create(ws, { title: "Vendor contract", ownerBotId: f.bot.id });
    ctx.tasks.update(ws, blocked.id, {
      version: blocked.version,
      status: "blocked",
      blockedReason: "waiting for legal",
      nextAction: "ask legal on Monday",
    });
    const gone = ctx.tasks.create(ws, { title: "Deleted errand" });
    ctx.tasks.softDelete(ws, gone.id, { version: gone.version }, `user:${f.ids.ada}`);
    const quiet = ctx.tasks.create(ws, { title: "Private errand", threadIds: [privateId] });
    // A run in the shared chat records progress; a run in a Member's private chat records some
    // too. Both rows are finished in the same tick, before the scheduler could pick them up.
    const runIn = (threadId: string) => {
      const run = ctx.runs.create({
        botId: f.bot.id,
        threadId: threadId as never,
        lane: "background",
        triggerKind: "cron",
        triggerRef: "test",
        triggerPayload: { prompt: "" },
        config: {},
      });
      ctx.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(run.id);
      return run.id;
    };
    ctx.tasks.recordCheckpoint(runIn(shared.id), {
      taskId: report.id,
      completed: [
        { unit: "draft section 1", outcome: "written", evidence: ["/work/report/draft.md"] },
      ],
      outstanding: ["charts"],
      note: "half way there",
    });
    ctx.tasks.recordCheckpoint(runIn(privateId), {
      taskId: quiet.id,
      completed: [{ unit: "private step", outcome: "a member's private progress" }],
      note: "private note",
    });
    const inquiry = await openInquiry(f);
    await f.guest.fetch("POST", `/api/threads/${inquiry}/messages`, { body: { body: "tasks?" } });
    await waitFor(async () => jobs.length === 1, 3000, "job started");
    const job = jobs[0]?.modelJob;
    const projection = job?.kind === "status_inquiry" ? job.projection : "";
    expect(projection).toContain("Tasks (newest first):");
    expect(projection).toMatch(/Quarterly report \(planned; owner helper;/);
    expect(projection).toContain("draft section 1: written");
    expect(projection).toContain("outstanding: charts");
    expect(projection).toContain("half way there");
    expect(projection).toMatch(/Vendor contract \(blocked; owner helper;/);
    expect(projection).toContain("waiting for legal");
    expect(projection).toContain("ask legal on Monday");
    expect(projection).toMatch(/Private errand \(planned; no owner bot;/);
    for (const absent of [
      "Deleted errand",
      "secret description text",
      "/work/report/draft.md",
      "a member's private progress",
      "private note",
    ])
      expect(projection, absent).not.toContain(absent);
  });

  it("one open question per inquiry; a repeated externalId returns the stored message (S3)", async () => {
    const f = await seed();
    const inquiry = await openInquiry(f);
    let release: () => void = () => {};
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = await f.guest.json<{ message: { id: string } }>(
      "POST",
      `/api/threads/${inquiry}/messages`,
      { body: { body: "first?", externalId: "q-1" } },
    );
    expect(first.status).toBe(201);
    const again = await f.guest.json<{ message: { id: string }; runs: unknown[] }>(
      "POST",
      `/api/threads/${inquiry}/messages`,
      { body: { body: "first?", externalId: "q-1" } },
    );
    expect(again.status).toBe(200);
    expect(again.json.message.id).toBe(first.json.message.id);
    expect(again.json.runs).toEqual([]);
    const busy = await f.guest.json<{ details?: { reason?: string } }>(
      "POST",
      `/api/threads/${inquiry}/messages`,
      { body: { body: "second?" } },
    );
    expect(busy.status).toBe(409);
    expect(busy.json.details?.reason).toBe("status_inquiry_busy");
    expect((await messagesOf(f.guest, inquiry)).map((m) => m.body)).toEqual(["first?"]);
    release();
    await waitFor(
      async () => (await messagesOf(f.guest, inquiry)).length === 2,
      3000,
      "first answered",
    );
    const next = await f.guest.fetch("POST", `/api/threads/${inquiry}/messages`, {
      body: { body: "second?" },
    });
    expect(next.status).toBe(201);
  });

  it("the answer is the Guest's alone, and a failed job says so in the inquiry (S1, S4)", async () => {
    const f = await seed();
    answer = "";
    const inquiry = await openInquiry(f);
    let runId = "";
    const stream = await streamText(
      f.harness,
      f.guest,
      async () => {
        const asked = await f.guest.json<{ runs: Array<{ id: string }> }>(
          "POST",
          `/api/threads/${inquiry}/messages`,
          { body: { body: "anything new?" } },
        );
        runId = asked.json.runs[0]?.id as string;
        await waitFor(
          async () => (await messagesOf(f.guest, inquiry)).length === 2,
          3000,
          "notice appended",
        );
      },
      100,
    );
    const messages = await messagesOf(f.guest, inquiry);
    expect(messages[1]).toMatchObject({ authorKind: "system", body: NO_STATUS_ANSWER, runId });
    expect(f.harness.app.deskmates.ctx.runs.mustGet(runId as never).status).toBe("failed");
    // The Guest's stream carries the notice but no run event; the Guest reads no run route.
    expect(stream).toContain(NO_STATUS_ANSWER);
    expect(stream).not.toContain("event: run_status");
    expect((await f.guest.fetch("GET", `/api/runs/${runId}`)).status).toBe(403);
    // Nobody else reads the inquiry, its run or its messages, the root included.
    for (const jar of [f.root, f.owner, f.admin, f.member]) {
      expect((await jar.fetch("GET", `/api/runs/${runId}`)).status).toBe(404);
      expect((await jar.fetch("GET", `/api/threads/${inquiry}/messages`)).status).toBe(404);
      expect(await (await jar.fetch("GET", "/api/runs")).text()).not.toContain(runId);
      expect(await (await jar.fetch("GET", "/api/threads")).text()).not.toContain(inquiry);
    }
  });

  it("a Guest still posts in no shared chat and no one else's inquiry (W6)", async () => {
    const f = await seed();
    const { ctx } = f.harness.app.deskmates;
    const group = ctx.threads.create({ workspaceId: f.workspace.id, botIds: [f.bot.id] });
    const refused = await f.guest.json<{ details?: { reason?: string } }>(
      "POST",
      `/api/threads/${group.id}/messages`,
      { body: { body: "hello?" } },
    );
    expect(refused.status).toBe(403);
    expect(refused.json.details?.reason).toBe("guest_read_only");
    expect(runRows(f)).toHaveLength(0);
  });
});
