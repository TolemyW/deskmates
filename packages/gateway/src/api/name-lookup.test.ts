// T1, #113 §3.2: bounded name lookups. `GET /api/bots|threads|workspaces?ids=` return only the
// named rows the unpaged list would show the caller, at most 100 ids per request. Unknown ids,
// another tenant's rows, workspaces the caller does not belong to and other people's private
// chats are omitted.

import {
  type BotDefinition,
  type BotId,
  CSRF_HEADER,
  type Thread,
  type ThreadId,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor } from "../auth/tokens.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";
type Who = { token: string; csrf: string };

let app: FastifyInstance;
let A: TenantFixture;
let B: TenantFixture;
let member: Who;
let memberId: string;
let otherWorkspace: WorkspaceId;
let otherBot: BotId;
let privateChat: ThreadId;
let ownChat: ThreadId;

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
  const ctx = app.deskmates.ctx;
  A = await seedTenant(ctx, "A");
  B = await seedTenant(ctx, "B");
  // A second workspace of tenant A that the Member does not belong to.
  otherWorkspace = ctx.workspaces.create({
    tenantId: A.tenantId,
    name: "other",
    sandboxProvider: "docker",
    ownerUserId: A.ownerUserId,
  }).id as WorkspaceId;
  otherBot = ctx.bots.create({ workspaceId: otherWorkspace, name: "other-bot", role: "r" })
    .id as BotId;
  const user = await ctx.auth.createUser({
    loginName: "lookup-member",
    displayName: "Lookup member",
    password: FIXTURE_PASSWORD,
    role: "member",
    tenantId: A.tenantId,
    workspaceId: A.ids.workspace,
  });
  memberId = user.id;
  const { token } = await ctx.auth.login("lookup-member", FIXTURE_PASSWORD, "lookup");
  member = { token, csrf: csrfTokenFor(token) };
  const chat = (privateTo: string) => {
    const id = ctx.threads.create({
      workspaceId: A.ids.workspace as WorkspaceId,
      botIds: [A.ids.bot as BotId],
    }).id as ThreadId;
    ctx.db.prepare("UPDATE threads SET private_to_user_id = ? WHERE id = ?").run(privateTo, id);
    return id;
  };
  privateChat = chat(A.ownerUserId);
  ownChat = chat(memberId);
});
afterAll(async () => {
  await app.close();
});

async function get(who: Who, url: string) {
  return app.inject({
    method: "GET",
    url,
    headers: {
      cookie: `${SESSION}=${who.token}`,
      host: HOST,
      origin: `http://${HOST}`,
      [CSRF_HEADER]: who.csrf,
    },
  } as InjectOptions);
}

async function lookup<T extends { id: string }>(
  who: Who,
  path: string,
  key: string,
  ids: string[],
): Promise<string[]> {
  const res = await get(who, `${path}?ids=${ids.map(encodeURIComponent).join(",")}`);
  expect(res.statusCode, res.body).toBe(200);
  return ((res.json() as Record<string, T[]>)[key] ?? []).map((row) => row.id);
}

describe("bounded name lookups (#113 §3.2)", () => {
  it("bots: only the named, visible bots of the caller's tenant", async () => {
    const named = [otherBot, A.ids.bot, B.ids.bot, "bot_unknown"];
    expect(await lookup<BotDefinition>(A, "/api/bots", "bots", named)).toEqual([
      A.ids.bot,
      otherBot,
    ]);
    // A Member sees the bots of the workspaces they belong to, as in the whole list.
    expect(await lookup<BotDefinition>(member, "/api/bots", "bots", named)).toEqual([A.ids.bot]);
    expect(await lookup<BotDefinition>(B, "/api/bots", "bots", named)).toEqual([B.ids.bot]);
  });

  it("bots: a workspace filter narrows the lookup", async () => {
    const res = await get(
      A,
      `/api/bots?workspaceId=${otherWorkspace}&ids=${A.ids.bot},${otherBot}`,
    );
    expect((res.json() as { bots: BotDefinition[] }).bots.map((b) => b.id)).toEqual([otherBot]);
  });

  it("threads: no other person's private chat, and another tenant's thread is omitted", async () => {
    const named = [A.ids.thread, privateChat, ownChat, B.ids.thread, "thr_unknown"];
    expect(await lookup<Thread>(member, "/api/threads", "threads", named)).toEqual([
      A.ids.thread,
      ownChat,
    ]);
    const rows = (await get(member, `/api/threads?ids=${A.ids.thread}`)).json() as {
      threads: { id: string; memberIds: string[] }[];
    };
    expect(rows.threads[0]?.memberIds).toEqual([A.ids.bot]);
    expect(await lookup<Thread>(B, "/api/threads", "threads", named)).toEqual([B.ids.thread]);
  });

  it("workspaces: only the caller's", async () => {
    const named = [otherWorkspace, A.ids.workspace, B.ids.workspace];
    expect(await lookup<Workspace>(A, "/api/workspaces", "workspaces", named)).toEqual([
      A.ids.workspace,
      otherWorkspace,
    ]);
    expect(await lookup<Workspace>(member, "/api/workspaces", "workspaces", named)).toEqual([
      A.ids.workspace,
    ]);
  });

  it("each lookup equals the caller's whole list restricted to the named ids", async () => {
    const lists = [
      ["/api/bots", "bots"],
      ["/api/threads", "threads"],
      ["/api/workspaces", "workspaces"],
    ] as const;
    const everything = [
      ...Object.values(A.ids),
      ...Object.values(B.ids),
      otherWorkspace,
      otherBot,
      privateChat,
      ownChat,
    ];
    for (const who of [A, B, member])
      for (const [path, key] of lists) {
        const whole = ((await get(who, path)).json() as Record<string, { id: string }[]>)[key];
        const expected = (whole ?? []).map((row) => row.id).filter((id) => everything.includes(id));
        expect(await lookup(who, path, key, everything), path).toEqual(expected);
      }
  });

  it("refuses more than 100 ids on every lookup and names nothing for an empty list", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `id_${i}`).join(",");
    for (const path of ["/api/bots", "/api/threads", "/api/workspaces"]) {
      expect((await get(A, `${path}?ids=${many}`)).statusCode, path).toBe(400);
      const hundred = [A.ids.bot, ...Array.from({ length: 99 }, (_, i) => `id_${i}`)].join(",");
      expect((await get(A, `${path}?ids=${hundred}`)).statusCode, path).toBe(200);
    }
    expect(await lookup<BotDefinition>(A, "/api/bots", "bots", [])).toEqual([]);
  });
});
