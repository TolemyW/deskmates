// T1, #113 surface 26: a chat asks only for the approvals its loaded messages name. `ids=` returns
// those rows of the thread, pending and decided, at most 100 per request; unknown ids, another
// thread's ids and another tenant's thread are not returned.

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
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { type TenantFixture, seedTenant } from "../test-support/tenants.js";

const SESSION = "__Host-deskmates-session";
const HOST = "gw.test";

let app: FastifyInstance;
let A: TenantFixture;
let B: TenantFixture;
let thread: ThreadId;
let other: ThreadId;
const inThread: ApprovalId[] = [];
let elsewhere: ApprovalId;

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
  thread = newThread();
  other = newThread();
  for (let i = 0; i < 6; i += 1) inThread.push(approval(thread, `apr_t26_${i}`));
  elsewhere = approval(other, "apr_t26_other");
  // Two share a timestamp, so the id decides their order.
  const db = app.deskmates.ctx.db;
  inThread.forEach((id, i) => {
    const at = `2026-10-14T00:00:0${i < 2 ? 0 : i}.000Z`;
    db.prepare("UPDATE approvals SET created_at = ? WHERE id = ?").run(at, id);
  });
  app.deskmates.ctx.approvals.decide(inThread[1] as ApprovalId, "deny", "human:web");
});
afterAll(async () => {
  await app.close();
});

function newThread(): ThreadId {
  return app.deskmates.ctx.threads.create({
    workspaceId: A.ids.workspace as WorkspaceId,
    botIds: [A.ids.bot as BotId],
  }).id as ThreadId;
}

function approval(threadId: ThreadId, id: string): ApprovalId {
  const ctx = app.deskmates.ctx;
  const message = ctx.messages.append({
    threadId,
    authorKind: "human",
    authorId: "user:someone",
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
  ctx.approvals.create({
    id: id as ApprovalId,
    runId: run.id as RunId,
    botId: A.ids.bot as BotId,
    threadId,
    action: { toolName: "Bash", input: { command: "git push" } },
    riskLevel: "L2",
  });
  return id as ApprovalId;
}

async function get(who: TenantFixture, url: string) {
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

const ids = (res: { json: () => unknown }) =>
  (res.json() as { approvals: Approval[] }).approvals.map((a) => a.id);

describe("thread approvals bounded to the loaded messages (#113 surface 26)", () => {
  it("returns only the named approvals of the thread, pending and decided, oldest first", async () => {
    const named = [inThread[5], inThread[1], inThread[0], "apr_unknown", elsewhere].join(",");
    const res = await get(A, `/api/approvals?threadId=${thread}&ids=${named}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([inThread[0], inThread[1], inThread[5]]);
  });

  it("an explicit status still filters the named rows", async () => {
    const named = inThread.slice(0, 3).join(",");
    expect(
      ids(await get(A, `/api/approvals?threadId=${thread}&ids=${named}&status=decided`)),
    ).toEqual([inThread[1]]);
    expect(
      ids(await get(A, `/api/approvals?threadId=${thread}&ids=${named}&status=pending`)),
    ).toEqual([inThread[0], inThread[2]]);
  });

  it("refuses more than 100 ids and ids without a thread", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `apr_${i}`).join(",");
    expect((await get(A, `/api/approvals?threadId=${thread}&ids=${many}`)).statusCode).toBe(400);
    const hundred = [...inThread, ...Array.from({ length: 94 }, (_, i) => `apr_none_${i}`)].join(
      ",",
    );
    const capped = await get(A, `/api/approvals?threadId=${thread}&ids=${hundred}`);
    expect(capped.statusCode).toBe(200);
    expect(ids(capped)).toHaveLength(6);
    expect((await get(A, `/api/approvals?ids=${inThread[0]}`)).statusCode).toBe(400);
  });

  it("an empty list names nothing", async () => {
    expect(ids(await get(A, `/api/approvals?threadId=${thread}&ids=`))).toEqual([]);
  });

  it("another tenant cannot read the thread's approvals by id", async () => {
    const res = await get(B, `/api/approvals?threadId=${thread}&ids=${inThread.join(",")}`);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(inThread[0]);
  });

  it("without ids the thread's list is unchanged", async () => {
    const res = await get(A, `/api/approvals?threadId=${thread}&status=pending`);
    expect(ids(res)).toEqual([inThread[0], inThread[2], inThread[3], inThread[4], inThread[5]]);
  });
});
