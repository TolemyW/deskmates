// #113 slice B: a workspace's bots page by `name, id` with an honest total and server search,
// while the unpaged list stays the whole name map; a bot's approval rules are a numbered page.
// Limits above the maximum are refused.

import type { BotDefinition, BotId, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway, buildOperatorGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { TEST_OPERATOR_TOKEN, testConfig } from "../test-support/harness.js";

const human = { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` };
let sandbox: ReturnType<typeof buildGateway>;
let operator: ReturnType<typeof buildOperatorGateway>;
let workspaceId: WorkspaceId;
let otherWorkspaceId: WorkspaceId;

beforeEach(async () => {
  sandbox = buildGateway(testConfig(), new FakeProvider(), { startCron: false });
  operator = buildOperatorGateway(sandbox.deskmates);
  await Promise.all([sandbox.ready(), operator.ready()]);
  sandbox.deskmates.scheduler.stop();
  const ctx = sandbox.deskmates.ctx;
  workspaceId = ctx.workspaces.create({ name: "bots", sandboxProvider: "docker" }).id;
  otherWorkspaceId = ctx.workspaces.create({ name: "other", sandboxProvider: "docker" }).id;
});
afterEach(async () => {
  await operator.close();
  await sandbox.close();
});

function seedBots(count: number): BotId[] {
  const ctx = sandbox.deskmates.ctx;
  const ids: BotId[] = [];
  // Created in reverse name order, so `name, id` and creation order disagree.
  for (let i = count - 1; i >= 0; i -= 1) {
    const name = `bot-${String(i).padStart(2, "0")}`;
    ids.push(ctx.bots.create({ workspaceId, name, role: i % 2 ? "Analyst" : "writer" }).id);
  }
  ctx.bots.create({ workspaceId: otherWorkspaceId, name: "bot-zz", role: "analyst" });
  return ids;
}

async function get(url: string) {
  return operator.inject({ method: "GET", url, headers: human });
}

describe("bot pagination (#113 B)", () => {
  it("pages a workspace's bots by name with an honest total across three pages", async () => {
    seedBots(120);
    const names: string[] = [];
    for (const offset of [0, 50, 100]) {
      const body = (await get(`/api/bots?workspaceId=${workspaceId}&offset=${offset}`)).json();
      expect(body).toMatchObject({ offset, limit: 50, total: 120 });
      names.push(...body.bots.map((b: BotDefinition) => b.name));
    }
    expect(names).toHaveLength(120);
    expect(names).toEqual([...names].sort());
    const past = (await get(`/api/bots?workspaceId=${workspaceId}&offset=150`)).json();
    expect(past).toMatchObject({ bots: [], total: 120 });
    // The unpaged list is still the whole name map, every workspace included.
    expect((await get("/api/bots")).json().bots).toHaveLength(121);
  });

  it("searches name and role on the server and counts only the matches", async () => {
    seedBots(30);
    const body = (await get(`/api/bots?workspaceId=${workspaceId}&q=ANALYST&limit=10`)).json();
    expect(body.total).toBe(15);
    expect(body.bots).toHaveLength(10);
    const byName = (await get(`/api/bots?workspaceId=${workspaceId}&q=bot-2`)).json();
    expect(byName.bots.map((b: BotDefinition) => b.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `bot-2${i}`),
    );
  });

  it("refuses a limit over the maximum and a page without a workspace", async () => {
    seedBots(3);
    expect((await get(`/api/bots?workspaceId=${workspaceId}&limit=101`)).statusCode).toBe(400);
    expect((await get(`/api/bots?workspaceId=${workspaceId}&offset=-1`)).statusCode).toBe(400);
    expect((await get("/api/bots?limit=10")).statusCode).toBe(400);
  });

  it("pages a bot's approval rules by creation with the total", async () => {
    const [botId] = seedBots(1) as [BotId];
    const ctx = sandbox.deskmates.ctx;
    for (let i = 0; i < 30; i += 1)
      ctx.db
        .prepare(
          `INSERT INTO approval_rules (id, workspace_id, bot_id, matcher_json, decision, created_by, created_at)
           VALUES (?, ?, ?, '{}', 'deny', 'test', ?)`,
        )
        .run(`rule_${String(i).padStart(2, "0")}`, workspaceId, botId, "2026-10-14T00:00:00.000Z");
    const first = (await get(`/api/bots/${botId}/approval-rules`)).json();
    expect(first).toMatchObject({ offset: 0, limit: 25, total: 30 });
    const second = (await get(`/api/bots/${botId}/approval-rules?offset=25`)).json();
    expect([...first.rules, ...second.rules].map((r: { id: string }) => r.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `rule_${String(i).padStart(2, "0")}`),
    );
    expect((await get(`/api/bots/${botId}/approval-rules?limit=101`)).statusCode).toBe(400);
  });
});
