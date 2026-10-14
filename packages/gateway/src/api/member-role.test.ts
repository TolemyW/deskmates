// T1: ADR-0022 amendment 1 as amendment 6 (W5, W7) narrows it. Two tenants, A and B, from the
// shared fixture. A Member of A reads the workspace, posts in its shared chats and their own
// private chats, executes tasks, answers approvals of the runs they started once, stops their own
// runs, acknowledges cost alerts and proposes Knowledge; every act that changes the group's
// configuration (its chats, members, tasks, memory, persistent approval answers) is an Admin's
// and is refused with a typed 403 and no side effect. A private chat is its person's alone.

import {
  type ApprovalId,
  type BotId,
  CSRF_HEADER,
  type RunId,
  type ThreadId,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "../auth/tokens.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import {
  FIXTURE_PASSWORD,
  type TenantFixture,
  seedTenant,
  snapshotDatabase,
} from "../test-support/tenants.js";
import { ROUTE_POLICY } from "./route-policy.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";

type Who = { token: string; csrf: string };

let app: FastifyInstance;
let A: TenantFixture;
let B: TenantFixture;
let member: Who;
let otherMember: Who;
let admin: Who;
let memberUserId: string;
/** A second bot in A's workspace, for group chats and mentions. */
let secondBot: BotId;

beforeAll(async () => {
  app = buildGateway(
    testConfig({
      secretsKey: Buffer.alloc(32, 7).toString("base64"),
      auth: { argon2: { memoryKiB: 1024, iterations: 1, parallelism: 1 }, liveSweepMs: 0 },
    }),
    new FakeProvider(),
    { surface: "combined-test", startCron: false },
  );
  await app.ready();
  app.deskmates.scheduler.stop();
  A = await seedTenant(app.deskmates.ctx, "A");
  B = await seedTenant(app.deskmates.ctx, "B");
  const memberA = await person(A, "member", "member-a");
  member = memberA.who;
  memberUserId = memberA.userId;
  otherMember = (await person(A, "member", "member-a2")).who;
  admin = (await person(A, "admin", "admin-a")).who;
  secondBot = app.deskmates.ctx.bots.create({
    name: "secondbot",
    role: "second",
    workspaceId: A.ids.workspace as WorkspaceId,
  }).id;
});
afterAll(async () => {
  await app.close();
});

async function person(tenant: TenantFixture, role: "member" | "admin", name: string) {
  const ctx = app.deskmates.ctx;
  const user = await ctx.auth.createUser({
    loginName: name,
    displayName: name,
    password: FIXTURE_PASSWORD,
    role,
    tenantId: tenant.tenantId,
  });
  const { token } = await ctx.auth.login(name, FIXTURE_PASSWORD, name);
  return { who: { token, csrf: csrfTokenFor(token) }, userId: user.id };
}

function as(who: Who, method: string, url: string, payload?: unknown) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: {
      cookie: `${SESSION}=${who.token}`,
      host: HOST,
      origin: `http://${HOST}`,
      [CSRF_HEADER]: who.csrf,
    },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies: the inject typing wants a narrower payload type than tests need.
  return app.inject(options as unknown as InjectOptions);
}

function freshThread(botIds: BotId[] = [A.ids.bot as BotId]): ThreadId {
  return app.deskmates.ctx.threads.create({ workspaceId: A.ids.workspace as WorkspaceId, botIds })
    .id;
}

/** A message of `author` in `threadId`, the trigger of a run that person started (W5). */
function triggerBy(threadId: ThreadId, author: string | undefined): string {
  if (author === undefined) return "member-role";
  return app.deskmates.ctx.messages.append({
    threadId,
    authorKind: "human",
    authorId: author,
    body: "please do it",
  }).id;
}

function pendingApproval(kind?: "egress", startedBy?: string): ApprovalId {
  const ctx = app.deskmates.ctx;
  const threadId = freshThread();
  const run = ctx.runs.create({
    botId: A.ids.bot as BotId,
    threadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: triggerBy(threadId, startedBy),
    config: ctx.runConfig(),
  });
  const id = `apr_member_${Math.random().toString(36).slice(2)}` as ApprovalId;
  ctx.approvals.create({
    id,
    runId: run.id as RunId,
    botId: A.ids.bot as BotId,
    threadId,
    action:
      kind === "egress"
        ? {
            toolName: "mcp__browser__browser_navigate",
            input: { url: "https://new-site.example.org/page" },
            targetOrigin: "https://new-site.example.org",
          }
        : { toolName: "Bash", input: { command: "echo hi" } },
    riskLevel: "L2",
    ...(kind ? { kind } : {}),
  });
  return id;
}

/** Every route amendment 1 moved from Member to Admin, with a request a Member might send. */
function adminOnlyRequests(): Array<[string, string, string, unknown?]> {
  const ws = A.ids.workspace;
  const task = A.ids.task;
  return [
    [
      "POST /api/threads/:id/members",
      "POST",
      `/api/threads/${A.ids.thread}/members`,
      { botIds: [secondBot] },
    ],
    [
      "DELETE /api/threads/:id/members/:botId",
      "DELETE",
      `/api/threads/${A.ids.thread}/members/${A.ids.bot}`,
    ],
    [
      "PATCH /api/threads/:id",
      "PATCH",
      `/api/threads/${A.ids.thread}`,
      { deadline: "2030-01-01T00:00:00Z" },
    ],
    ["POST /api/threads/:id/close-task", "POST", `/api/threads/${A.ids.thread}/close-task`, {}],
    [
      "POST /api/workspaces/:workspaceId/tasks",
      "POST",
      `/api/workspaces/${ws}/tasks`,
      { title: "member task" },
    ],
    [
      "PATCH /api/workspaces/:workspaceId/tasks/:id",
      "PATCH",
      `/api/workspaces/${ws}/tasks/${task}`,
      { title: "renamed" },
    ],
    [
      "POST /api/workspaces/:workspaceId/tasks/:id/accept",
      "POST",
      `/api/workspaces/${ws}/tasks/${task}/accept`,
      {},
    ],
    [
      "PATCH /api/bots/:id/memory",
      "PATCH",
      `/api/bots/${A.ids.bot}/memory`,
      { body: "x", expectedVersion: "0".repeat(64) },
    ],
    [
      "POST /api/bots/:id/memory/consolidate",
      "POST",
      `/api/bots/${A.ids.bot}/memory/consolidate`,
      {},
    ],
    [
      "PATCH /api/memory/entries/:id",
      "PATCH",
      `/api/memory/entries/${A.ids.memoryEntry}`,
      { body: "edited" },
    ],
    [
      "POST /api/memory/entries/:id/forget",
      "POST",
      `/api/memory/entries/${A.ids.memoryEntry}/forget`,
      {},
    ],
    [
      "POST /api/memory/entries/:id/undo",
      "POST",
      `/api/memory/entries/${A.ids.memoryEntry}/undo`,
      {},
    ],
    [
      "POST /api/memory/entries/:id/confirm",
      "POST",
      `/api/memory/entries/${A.ids.memoryEntry}/confirm`,
      {},
    ],
    [
      "POST /api/memory-suggestions/:id/review",
      "POST",
      `/api/memory-suggestions/${A.ids.memorySuggestion}/review`,
      { decision: "reject" },
    ],
  ];
}

describe("ADR-0022 amendment 1: Admins own the group", () => {
  it("every route moved to Admin is an Admin route in ROUTE_POLICY, with no bypass for any principal", () => {
    for (const [key] of adminOnlyRequests()) {
      const policy = ROUTE_POLICY[key];
      expect(policy, key).toEqual(expect.objectContaining({ access: "tenant", role: "admin" }));
    }
    // A service principal is checked by its own tenant role (A10); no route has an exception.
    for (const [key, policy] of Object.entries(ROUTE_POLICY))
      expect(Object.keys(policy), key).not.toContain("serviceAccess");
  });

  it("refuses a Member every shared-state route with 403 and no side effect", async () => {
    const before = snapshotDatabase(app.deskmates.ctx);
    for (const [key, method, url, body] of adminOnlyRequests()) {
      const response = await as(member, method, url, body);
      expect(response.statusCode, key).toBe(403);
      expect(response.json().code, key).toBe("forbidden");
    }
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
  });

  it("lets an Admin past the role check on every one of them", async () => {
    for (const [key, method, url, body] of adminOnlyRequests()) {
      const response = await as(admin, method, url, body);
      expect(response.statusCode, `${key}: ${response.body}`).not.toBe(403);
    }
  });

  it("an Admin changes the group: members, deadline, tasks and memory curation succeed", async () => {
    const thread = freshThread();
    const added = await as(admin, "POST", `/api/threads/${thread}/members`, {
      botIds: [secondBot],
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(
      (await as(admin, "DELETE", `/api/threads/${thread}/members/${secondBot}`)).statusCode,
    ).toBe(200);
    const deadline = await as(admin, "PATCH", `/api/threads/${thread}`, {
      deadline: "2030-01-01T00:00:00Z",
    });
    expect(deadline.statusCode, deadline.body).toBe(200);
    const created = await as(admin, "POST", `/api/workspaces/${A.ids.workspace}/tasks`, {
      title: "admin task",
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id: taskId, version } = created.json().task as { id: string; version: number };
    const edited = await as(admin, "PATCH", `/api/workspaces/${A.ids.workspace}/tasks/${taskId}`, {
      title: "admin task, renamed",
      version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const entry = app.deskmates.ctx.memory.entries.insert({
      workspaceId: A.ids.workspace as WorkspaceId,
      scope: "workspace",
      kind: "note",
      body: "a fact an Admin curates",
      authority: "fact",
      trust: "trusted",
      sourceKind: "human",
      by: "human:fixture",
    });
    const confirmed = await as(admin, "POST", `/api/memory/entries/${entry.id}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
  });

  it("a Member posts in the group but creates no group, binding or canonical chat (amendment 6 W5)", async () => {
    const group = freshThread([A.ids.bot as BotId, secondBot]);
    const posted = await as(member, "POST", `/api/threads/${group}/messages`, { body: "hello" });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(
      (await as(member, "POST", `/api/threads/${A.ids.thread}/messages`, { body: "hi" }))
        .statusCode,
    ).toBe(201);
    app.deskmates.ctx.bots.create({
      name: "outsiderbot",
      role: "outside",
      workspaceId: A.ids.workspace as WorkspaceId,
    });
    const before = snapshotDatabase(app.deskmates.ctx);
    // A mention that would add a bot to the group is an Admin's.
    const refused = await as(member, "POST", `/api/threads/${group}/messages`, {
      body: "@outsiderbot join us",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "forbidden",
      details: { reason: "admin_owns_the_group" },
    });
    // The private chat does not exist yet: a Member cannot create it.
    expect((await as(member, "POST", `/api/bots/${secondBot}/private-chat`)).statusCode).toBe(403);
    // A group chat is not a side chat.
    expect(
      (
        await as(member, "POST", "/api/threads", {
          workspaceId: A.ids.workspace,
          botIds: [A.ids.bot, secondBot],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await as(member, "POST", "/api/threads", {
          workspaceId: A.ids.workspace,
          botIds: [A.ids.bot],
          channel: "whatsapp",
          externalKey: "member-binding",
        })
      ).statusCode,
    ).toBe(403);
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);

    expect(
      (await as(admin, "POST", `/api/threads/${group}/messages`, { body: "hello" })).statusCode,
    ).toBe(201);
    const opened = await as(admin, "POST", `/api/bots/${secondBot}/private-chat`);
    expect(opened.statusCode, opened.body).toBe(200);
    // Once it exists, a Member reads it through the same route and posts in it: it is shared.
    const read = await as(member, "POST", `/api/bots/${secondBot}/private-chat`);
    expect(read.statusCode).toBe(200);
    expect(read.json().thread.id).toBe(opened.json().thread.id);
    expect(
      (await as(member, "POST", `/api/threads/${read.json().thread.id}/messages`, { body: "x" }))
        .statusCode,
    ).toBe(201);
    const group2 = await as(admin, "POST", "/api/threads", {
      workspaceId: A.ids.workspace,
      botIds: [A.ids.bot, secondBot],
    });
    expect(group2.statusCode).toBe(201);
    expect(group2.json().thread.sideChatActor).toBeUndefined();
  });
});

describe("ADR-0022 amendment 1: a Member's side chat", () => {
  it("a Member opens a side chat with one bot and posts in it; it is marked theirs", async () => {
    const created = await as(member, "POST", "/api/threads", {
      workspaceId: A.ids.workspace,
      botIds: [A.ids.bot],
      title: "my side chat",
    });
    expect(created.statusCode, created.body).toBe(201);
    const thread = created.json().thread;
    expect(thread).toMatchObject({ kind: "chat", channel: "web" });
    expect(thread.sideChatActor).toBe(`user:${memberUserId}`);
    const posted = await as(member, "POST", `/api/threads/${thread.id}/messages`, {
      body: "a question",
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().message.authorId).toBe(`user:${memberUserId}`);
    expect(thread.privateToUserId).toBe(memberUserId);
    // It is private to them (amendment 6 W7): another Member and an Admin get the uniform 404.
    for (const other of [otherMember, admin]) {
      expect((await as(other, "GET", `/api/threads/${thread.id}/messages`)).statusCode).toBe(404);
      expect(
        (await as(other, "POST", `/api/threads/${thread.id}/messages`, { body: "me too" }))
          .statusCode,
      ).toBe(404);
    }
  });

  it("a Member cannot turn a side chat into a group by a mention, and nobody else can reach it", async () => {
    const created = await as(member, "POST", "/api/threads", {
      workspaceId: A.ids.workspace,
      botIds: [A.ids.bot],
    });
    const threadId = created.json().thread.id as ThreadId;
    const before = snapshotDatabase(app.deskmates.ctx);
    const mention = await as(member, "POST", `/api/threads/${threadId}/messages`, {
      body: "@secondbot can you help?",
    });
    expect(mention.statusCode).toBe(403);
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
    // Mentioning the one bot already in it is fine.
    const own = app.deskmates.ctx.bots.mustGet(A.ids.bot as BotId).name;
    expect(
      (await as(member, "POST", `/api/threads/${threadId}/messages`, { body: `@${own} hi` }))
        .statusCode,
    ).toBe(201);
    // An Admin cannot even see it to add a bot: it is the Member's private chat (W7).
    expect(
      (await as(admin, "POST", `/api/threads/${threadId}/members`, { botIds: [secondBot] }))
        .statusCode,
    ).toBe(404);
  });

  it("a side chat is never adopted as the bot's canonical private chat", async () => {
    const ctx = app.deskmates.ctx;
    const bot = ctx.bots.create({
      name: "adoptbot",
      role: "adopt",
      workspaceId: A.ids.workspace as WorkspaceId,
    });
    const side = await as(member, "POST", "/api/threads", {
      workspaceId: A.ids.workspace,
      botIds: [bot.id],
    });
    expect(side.statusCode).toBe(201);
    const opened = await as(admin, "POST", `/api/bots/${bot.id}/private-chat`);
    expect(opened.statusCode).toBe(200);
    expect(opened.json().thread.id).not.toBe(side.json().thread.id);
  });

  it("another tenant's workspace or bot is the uniform 404 for a side chat, as for any route", async () => {
    const response = await as(member, "POST", "/api/threads", {
      workspaceId: B.ids.workspace,
      botIds: [B.ids.bot],
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("ADR-0022 amendment 1: approvals (C1/C3)", () => {
  it("a Member answers only approvals of runs they started (amendment 6 W5)", async () => {
    const others = pendingApproval();
    const before = snapshotDatabase(app.deskmates.ctx);
    const refused = await as(member, "POST", `/api/approvals/${others}/decide`, {
      decision: "allow_once",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().details?.reason).toBe("run_not_started_by_you");
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
    const mine = pendingApproval(undefined, `user:${memberUserId}`);
    const answered = await as(member, "POST", `/api/approvals/${mine}/decide`, {
      decision: "allow_once",
    });
    expect(answered.statusCode, answered.body).toBe(200);
  });

  it("a Member answers once or denies, never always", async () => {
    const always = pendingApproval(undefined, `user:${memberUserId}`);
    const before = snapshotDatabase(app.deskmates.ctx);
    const refused = await as(member, "POST", `/api/approvals/${always}/decide`, {
      decision: "allow_always",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "forbidden",
      details: { reason: "persistent_answer_needs_admin", decision: "allow_always" },
    });
    expect(app.deskmates.ctx.approvals.mustGet(always).decision).toBeUndefined();
    // No rule was stored and nothing else moved.
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
    for (const decision of ["allow_once", "deny"] as const) {
      const id = pendingApproval(undefined, `user:${memberUserId}`);
      const answered = await as(member, "POST", `/api/approvals/${id}/decide`, { decision });
      expect(answered.statusCode, answered.body).toBe(200);
      expect(app.deskmates.ctx.approvals.mustGet(id).decision).toBe(decision);
    }
  });

  it("a Member cannot allow a site; an Admin can, and the host joins the allowlist", async () => {
    const ctx = app.deskmates.ctx;
    const id = pendingApproval("egress", `user:${memberUserId}`);
    const allowlist = ctx.workspaces.mustGet(A.ids.workspace as WorkspaceId).egressAllowlist;
    const refused = await as(member, "POST", `/api/approvals/${id}/decide`, {
      decision: "allow_always",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain("allow this site");
    expect(ctx.workspaces.mustGet(A.ids.workspace as WorkspaceId).egressAllowlist).toEqual(
      allowlist,
    );
    const allowed = await as(admin, "POST", `/api/approvals/${id}/decide`, {
      decision: "allow_always",
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(ctx.workspaces.mustGet(A.ids.workspace as WorkspaceId).egressAllowlist).toContain(
      "new-site.example.org",
    );
  });

  it("an Admin may always allow, which stores a rule", async () => {
    const id = pendingApproval();
    const allowed = await as(admin, "POST", `/api/approvals/${id}/decide`, {
      decision: "allow_always",
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(app.deskmates.ctx.approvals.mustGet(id).decision).toBe("allow_always");
  });
});

describe("ADR-0022 amendment 1: what a Member keeps", () => {
  it("reads every route and acknowledges cost alerts and proposes Knowledge", async () => {
    for (const url of [
      `/api/workspaces/${A.ids.workspace}`,
      `/api/threads?workspaceId=${A.ids.workspace}`,
      `/api/threads/${A.ids.thread}/messages`,
      `/api/runs/${A.ids.run}`,
      `/api/workspaces/${A.ids.workspace}/tasks`,
      `/api/workspaces/${A.ids.workspace}/memory`,
      `/api/memory-suggestions?workspaceId=${A.ids.workspace}`,
      "/api/costs",
      "/api/approvals",
    ]) {
      const response = await as(member, "GET", url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    const ack = await as(member, "POST", `/api/cost-alerts/${A.ids.costAlert}/acknowledge`, {});
    expect(ack.statusCode, ack.body).toBe(200);
    const proposal = await as(member, "POST", "/api/knowledge/proposals", {
      title: "member note",
      body: "something useful",
    });
    expect(proposal.statusCode, proposal.body).toBe(201);
  });
});

describe("ADR-0022 amendment 1: runs a Member may stop or continue (A11, A12)", () => {
  /** A queued run of A's bot in `threadId`, optionally parked on a continuation ask. */
  function runIn(
    threadId: ThreadId,
    continuation = false,
    startedBy?: string,
  ): { runId: RunId; approvalId?: ApprovalId } {
    const ctx = app.deskmates.ctx;
    const run = ctx.runs.create({
      botId: A.ids.bot as BotId,
      threadId,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: startedBy === undefined ? "member-run" : triggerBy(threadId, startedBy),
      config: ctx.runConfig(),
    });
    if (!continuation) return { runId: run.id as RunId };
    const approvalId = `apr_cont_${Math.random().toString(36).slice(2)}` as ApprovalId;
    ctx.approvals.create({
      id: approvalId,
      runId: run.id as RunId,
      botId: A.ids.bot as BotId,
      threadId,
      action: { toolName: "continuation", input: {} },
      riskLevel: "L2",
    });
    // The run lifecycle writes continuation asks directly; the store's input names egress only.
    ctx.db.prepare("UPDATE approvals SET kind = 'continuation' WHERE id = ?").run(approvalId);
    ctx.db
      .prepare(
        "UPDATE runs SET status = 'waiting_continuation', resume_payload_json = ? WHERE id = ?",
      )
      .run(JSON.stringify({ sdkSessionId: "sess", approvalId, continuation: true }), run.id);
    return { runId: run.id as RunId, approvalId };
  }

  async function sideChatOf(who: Who): Promise<ThreadId> {
    const created = await as(who, "POST", "/api/threads", {
      workspaceId: A.ids.workspace,
      botIds: [A.ids.bot],
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().thread.id as ThreadId;
  }

  it("a Member cancels only the runs they started; an Admin cancels any", async () => {
    const group = runIn(freshThread([A.ids.bot as BotId, secondBot]));
    const others = runIn(await sideChatOf(otherMember));
    const before = snapshotDatabase(app.deskmates.ctx);
    const refused = await as(member, "POST", `/api/runs/${group.runId}/cancel`, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "forbidden",
      details: { reason: "run_not_started_by_you" },
    });
    // Another Member's private chat is not even visible (amendment 6 W7).
    expect((await as(member, "POST", `/api/runs/${others.runId}/cancel`, {})).statusCode).toBe(404);
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);
    // A run their own message woke in the group is theirs to stop (W5).
    const started = runIn(
      freshThread([A.ids.bot as BotId, secondBot]),
      false,
      `user:${memberUserId}`,
    );
    expect((await as(member, "POST", `/api/runs/${started.runId}/cancel`, {})).statusCode).toBe(
      200,
    );

    const mine = runIn(await sideChatOf(member));
    const cancelled = await as(member, "POST", `/api/runs/${mine.runId}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");
    const byAdmin = await as(admin, "POST", `/api/runs/${group.runId}/cancel`, {});
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
  });

  it("a Member answers a turn-continuation ask only in their own side chat; an Admin anywhere", async () => {
    const group = runIn(freshThread([A.ids.bot as BotId, secondBot]), true);
    const before = snapshotDatabase(app.deskmates.ctx);
    const refused = await as(member, "POST", `/api/runs/${group.runId}/continuation/decide`, {
      decision: "continue",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "forbidden",
      details: { reason: "run_not_started_by_you" },
    });
    expect(snapshotDatabase(app.deskmates.ctx)).toBe(before);

    const mine = runIn(await sideChatOf(member), true);
    const answered = await as(member, "POST", `/api/runs/${mine.runId}/continuation/decide`, {
      decision: "stop",
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(app.deskmates.ctx.approvals.mustGet(mine.approvalId as ApprovalId).decision).toBe(
      "deny",
    );
    const byAdmin = await as(admin, "POST", `/api/runs/${group.runId}/continuation/decide`, {
      decision: "continue",
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
  });
});
