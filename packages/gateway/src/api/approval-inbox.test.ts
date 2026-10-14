// T1, #113 surface 23: the Attention inbox is a keyset page of pending approvals, oldest first,
// 25 by default and at most 100, with the honest total of what the caller may see. Below Admin
// the caller sees only the requests of runs they started (ADR-0022 amendment 6 W5).

import {
  type Approval,
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
import { FIXTURE_PASSWORD, type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";
type Who = { token: string; csrf: string };
type Page = { approvals: Approval[]; nextCursor?: string; total: number };

let app: FastifyInstance;
let A: TenantFixture;
let member: Who;
let memberUserId: string;
let admin: Who;
const created: ApprovalId[] = [];

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
  const m = await person("member", "inbox-member");
  member = m.who;
  memberUserId = m.userId;
  admin = (await person("admin", "inbox-admin")).who;
  // The fixture holds one pending request of its own. 60 more: 3 started by the Member, the rest by someone else. Twelve share one
  // timestamp so the id tie-breaker decides their order.
  for (let i = 0; i < 60; i += 1)
    created.push(pending(i % 20 === 0 ? `user:${memberUserId}` : "user:someone-else"));
  const db = app.deskmates.ctx.db;
  created.forEach((id, i) => {
    const at =
      i >= 30 && i < 42
        ? "2026-10-14T00:00:30.000Z"
        : `2026-10-14T00:00:${String(i).padStart(2, "0")}.000Z`;
    db.prepare("UPDATE approvals SET created_at = ? WHERE id = ?").run(at, id);
  });
  // One decided request never appears.
  app.deskmates.ctx.approvals.decide(created[59] as ApprovalId, "deny", "human:web");
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

function pending(author: string): ApprovalId {
  const ctx = app.deskmates.ctx;
  const threadId = ctx.threads.create({
    workspaceId: A.ids.workspace as WorkspaceId,
    botIds: [A.ids.bot as BotId],
  }).id as ThreadId;
  const message = ctx.messages.append({
    threadId,
    authorKind: "human",
    authorId: author,
    body: "go",
  });
  const run = ctx.runs.create({
    botId: A.ids.bot as BotId,
    threadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: message.id,
    config: ctx.runConfig(),
  });
  const id =
    `apr_inbox_${String(created.length).padStart(2, "0")}_${Math.random().toString(36).slice(2, 6)}` as ApprovalId;
  ctx.approvals.create({
    id,
    runId: run.id as RunId,
    botId: A.ids.bot as BotId,
    threadId,
    action: { toolName: "Bash", input: { command: "git push" } },
    riskLevel: "L2",
  });
  return id;
}

async function get(who: Who, url: string) {
  const headers: Record<string, string> = {
    cookie: `${SESSION}=${who.token}`,
    host: HOST,
    origin: `http://${HOST}`,
    [CSRF_HEADER]: who.csrf,
  };
  return app.inject({ method: "GET", url, headers } as InjectOptions);
}

async function walk(who: Who, limit?: number): Promise<{ pages: Page[]; ids: string[] }> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({
      ...(limit ? { limit: String(limit) } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const res = await get(who, `/api/approvals?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as Page;
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return { pages, ids: pages.flatMap((page) => page.approvals.map((a) => a.id)) };
}

describe("Attention inbox paging (#113 surface 23)", () => {
  it("pages an Admin through every pending request oldest first, 25 at a time, with the total", async () => {
    const { pages, ids } = await walk(admin);
    expect(pages.map((page) => page.approvals.length)).toEqual([25, 25, 10]);
    expect(pages.every((page) => page.total === 60)).toBe(true);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    const keys = pages.flatMap((page) => page.approvals.map((a) => [a.createdAt, a.id]));
    const sorted = [...keys].sort((x, y) =>
      x[0] === y[0]
        ? (x[1] as string) < (y[1] as string)
          ? -1
          : 1
        : (x[0] as string) < (y[0] as string)
          ? -1
          : 1,
    );
    expect(keys).toEqual(sorted);
    expect(ids).not.toContain(created[59]);
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
  });

  it("an exact last page leaves no further cursor", async () => {
    const { pages } = await walk(admin, 60);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.nextCursor).toBeUndefined();
  });

  it("refuses a limit over 100 and a cursor from another scope", async () => {
    expect((await get(admin, "/api/approvals?limit=101")).statusCode).toBe(400);
    expect((await get(admin, "/api/approvals?limit=0")).statusCode).toBe(400);
    const first = (await get(admin, "/api/approvals?limit=5")).json() as Page;
    const cursor = first.nextCursor as string;
    const foreign = await get(
      admin,
      `/api/approvals?cursor=${cursor}&botId=${encodeURIComponent(A.ids.bot)}`,
    );
    expect(foreign.statusCode).toBe(400);
    expect((await get(member, `/api/approvals?cursor=${cursor}`)).statusCode).toBe(400);
    expect((await get(admin, "/api/approvals?cursor=garbage")).statusCode).toBe(400);
  });

  it("shows a Member only the requests of runs they started, with that total", async () => {
    const { pages, ids } = await walk(member);
    expect(pages[0]?.total).toBe(3);
    expect(ids).toEqual([created[0], created[20], created[40]]);
  });
});
