// T1: ADR-0017 amendment 2, a thread owned by an external chat channel is a read-only mirror on
// the Web. The human converses on that channel; a person's or a service principal's post through
// `POST /api/threads/:id/messages` is refused with a typed error and leaves no message or run.
// The shared operator credential stays the legacy standalone adapters' bridge, and the same Bot's
// canonical Web private chat and agent-submission threads stay writable.

import {
  type BotId,
  CSRF_HEADER,
  type ThreadId,
  WHATSAPP_CHANNEL,
  type WorkspaceId,
  agentChannel,
} from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "../auth/tokens.js";
import { DEFAULT_TENANT_ID } from "../auth/user-store.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";

type Who = { token: string; csrf: string };

let app: FastifyInstance;
let A: TenantFixture;
let admin: Who;
let member: Who;
let memberUserId: string;

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
  // The default tenant, so the shared operator credential reaches the same workspace.
  A = await seedTenant(app.deskmates.ctx, "A", DEFAULT_TENANT_ID);
  admin = A;
  const created = await person("member", "mirror-member");
  member = created.who;
  memberUserId = created.userId;
});
afterAll(async () => {
  await app.close();
});

async function person(role: "member" | "admin", name: string) {
  const ctx = app.deskmates.ctx;
  const user = await ctx.auth.createUser({
    loginName: name,
    displayName: name,
    password: FIXTURE_PASSWORD,
    role,
    tenantId: A.tenantId,
  });
  const { token } = await ctx.auth.login(name, FIXTURE_PASSWORD, name);
  return { who: { token, csrf: csrfTokenFor(token) }, userId: user.id };
}

function asSession(who: Who, method: string, url: string, payload?: unknown) {
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

function asBearer(token: string, method: string, url: string, payload?: unknown) {
  const options: Record<string, unknown> = {
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
  };
  if (payload !== undefined) options.payload = payload;
  // Arbitrary JSON bodies, as above.
  return app.inject(options as unknown as InjectOptions);
}

let keyCounter = 0;
function channelThread(channel: string = WHATSAPP_CHANNEL): ThreadId {
  keyCounter += 1;
  return app.deskmates.ctx.threads.create({
    workspaceId: A.ids.workspace as WorkspaceId,
    botIds: [A.ids.bot as BotId],
    channel,
    externalKey: `acct:${keyCounter}`,
    title: `Mirror ${keyCounter}`,
  }).id;
}

function footprint(threadId: ThreadId) {
  const ctx = app.deskmates.ctx;
  return {
    messages: ctx.messages.list(threadId, 0).length,
    runs: ctx.runs.list({ threadId }).length,
  };
}

describe("a channel-bound thread is a read-only Web mirror", () => {
  it("refuses an Admin's and a Member's session post with a typed error and no side effect", async () => {
    for (const who of [admin, member]) {
      const threadId = channelThread();
      const before = footprint(threadId);
      const res = await asSession(who, "POST", `/api/threads/${threadId}/messages`, {
        body: "hello from the web",
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({
        code: "channel_thread_read_only",
        details: { channel: WHATSAPP_CHANNEL },
      });
      expect(footprint(threadId)).toEqual(before);
    }
  });

  it("refuses a service principal's post, whatever author it names", async () => {
    // Service principals are the root's (ADR-0022 amendment 6 W2): the operator credential.
    const created = await asBearer(TEST_OPERATOR_TOKEN, "POST", "/api/service-principals", {
      name: "mirror-agent",
    });
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json().token as string;
    const threadId = channelThread();
    const before = footprint(threadId);
    const res = await asBearer(token, "POST", `/api/threads/${threadId}/messages`, {
      body: "from an agent",
      authorId: "whatsapp:15550001111",
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().code).toBe("channel_thread_read_only");
    expect(footprint(threadId)).toEqual(before);
  });

  it("keeps the shared operator credential working for the legacy standalone adapters", async () => {
    const threadId = channelThread();
    const res = await asBearer(TEST_OPERATOR_TOKEN, "POST", `/api/threads/${threadId}/messages`, {
      body: "inbound text",
      authorId: "whatsapp:15550001111",
      externalId: "wamid.mirror.1",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().message).toMatchObject({ authorId: "whatsapp:15550001111" });
  });

  it("keeps the same Bot's canonical Web private chat writable with its own thread", async () => {
    const mirror = channelThread();
    const opened = await asSession(admin, "POST", `/api/bots/${A.ids.bot}/private-chat`);
    expect(opened.statusCode, opened.body).toBe(200);
    const privateChat = opened.json().thread.id as ThreadId;
    expect(privateChat).not.toBe(mirror);
    const res = await asSession(admin, "POST", `/api/threads/${privateChat}/messages`, {
      body: "hello on the web",
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("keeps an agent-client submission thread writable for its submitter", async () => {
    const threadId = channelThread(agentChannel({ kind: "user", userId: memberUserId }));
    const res = await asSession(admin, "POST", `/api/threads/${threadId}/messages`, {
      body: "a follow-up",
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
