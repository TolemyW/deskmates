// T1, ADR-0002 amendment 3, A5: a workspace operator overrides a tool's tier. No override is the
// default and leaves the start request and the run row exactly as before; an Owner or Admin sets
// and removes one, a Member and a Guest cannot, each change is one audit row and the override
// records `createdBy`; tools tiered by their own policy are refused; a run freezes the overrides
// at its first start and a resume sends what the row recorded, never newer ones.

import type {
  RunEnded,
  StartRunRequest,
  ToolTierOverride,
  WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { openDatabase } from "../db/open.js";
import { BrowserJar, FAST_AUTH, TEST_PASSWORD } from "../test-support/browser-session.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { type Harness, startHarness, testConfig, waitFor } from "../test-support/harness.js";
import { createOwner } from "../test-support/owner.js";
import { ToolTierOverrides, toolTierStart } from "./tool-tier-overrides.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type List = { overrides: ToolTierOverride[] };
type One = { override: ToolTierOverride };

describe("tool tier override routes (A5)", () => {
  it("is empty by default, set and removed by an operator, audited, and records createdBy", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const base = `/api/workspaces/${workspace.id}/tool-tiers`;
    expect((await h.api<List>("GET", base)).json.overrides).toEqual([]);

    const set = await h.api<One>("PUT", `${base}/Agent`, { riskLevel: "L2" });
    expect(set.status).toBe(200);
    expect(set.json.override).toMatchObject({ toolName: "Agent", riskLevel: "L2" });
    expect(set.json.override.createdBy).toMatch(/^human:/);
    // Setting the same tier again changes and records nothing.
    await h.api("PUT", `${base}/Agent`, { riskLevel: "L2" });
    await h.api("PUT", `${base}/mcp__browser__browser_file_upload`, { riskLevel: "L1" });
    expect((await h.api<List>("GET", base)).json.overrides.map((o) => o.toolName)).toEqual([
      "Agent",
      "mcp__browser__browser_file_upload",
    ]);
    expect((await h.api("DELETE", `${base}/Agent`)).status).toBe(200);
    expect((await h.api("DELETE", `${base}/Agent`)).status).toBe(404);

    const audit = h.app.deskmates.ctx.audit
      .list({ workspaceId: workspace.id })
      .filter((row) => row.action === "workspace.tool_tier_set")
      .reverse();
    expect(audit.map((row) => [row.before, row.after])).toEqual([
      [
        { toolName: "Agent", riskLevel: null },
        { toolName: "Agent", riskLevel: "L2" },
      ],
      [
        { toolName: "mcp__browser__browser_file_upload", riskLevel: null },
        { toolName: "mcp__browser__browser_file_upload", riskLevel: "L1" },
      ],
      [
        { toolName: "Agent", riskLevel: "L2" },
        { toolName: "Agent", riskLevel: null },
      ],
    ]);
  });

  it("refuses an unknown tier, a malformed name and a tool tiered by its own policy", async () => {
    h = await startHarness();
    const { workspace } = await h.seed();
    const base = `/api/workspaces/${workspace.id}/tool-tiers`;
    expect((await h.api("PUT", `${base}/Agent`, { riskLevel: "L3" })).status).toBe(400);
    expect((await h.api("PUT", `${base}/bad%20name`, { riskLevel: "L1" })).status).toBe(400);
    for (const tool of ["mcp__deskmates__connector_submit", "mcp__deskmates__integration_execute"])
      expect((await h.api("PUT", `${base}/${tool}`, { riskLevel: "L0" })).status).toBe(400);
    expect((await h.api<List>("GET", base)).json.overrides).toEqual([]);
  });

  it("an Admin may change it; a Member may only read it, a Guest not even that", async () => {
    h = await startHarness({ auth: FAST_AUTH });
    const { ctx } = h.app.deskmates;
    await createOwner(ctx.auth, {
      loginName: "root",
      displayName: "Root",
      password: TEST_PASSWORD,
    });
    const ws = ctx.workspaces.create({ name: "A", sandboxProvider: "docker" });
    for (const [loginName, role] of [
      ["ada", "admin"],
      ["mel", "member"],
      ["gus", "guest"],
    ] as const)
      await ctx.auth.createUser({
        loginName,
        displayName: loginName,
        password: TEST_PASSWORD,
        role,
        workspaceId: ws.id,
      });
    const path = `/api/workspaces/${ws.id}/tool-tiers`;
    for (const login of ["mel", "gus"]) {
      const jar = new BrowserJar(h.baseUrl);
      expect((await jar.signIn(login)).status).toBe(200);
      // Reading is a Member's, like the approval mode; a Guest reads chats and the board only.
      expect((await jar.fetch("GET", path)).status).toBe(login === "mel" ? 200 : 403);
      expect((await jar.fetch("PUT", `${path}/Bash`, { body: { riskLevel: "L1" } })).status).toBe(
        403,
      );
      expect((await jar.fetch("DELETE", `${path}/Bash`)).status).toBe(403);
    }
    const admin = new BrowserJar(h.baseUrl);
    expect((await admin.signIn("ada")).status).toBe(200);
    const set = await admin.json<One>("PUT", `${path}/Bash`, { body: { riskLevel: "L1" } });
    expect(set.status).toBe(200);
    const userId = ctx.auth.users.findLocalLogin("ada")?.userId;
    expect(set.json.override.createdBy).toBe(`human:user:${userId}`);
    const row = ctx.audit
      .list({ workspaceId: ws.id })
      .find((entry) => entry.action === "workspace.tool_tier_set");
    expect(row?.actor).toBe(`user:${userId}`);
  });
});

describe("a run freezes its workspace's overrides (A5)", () => {
  async function startOnce(harness: Harness): Promise<{ req: StartRunRequest; runId: string }> {
    const { ctx, scheduler } = harness.app.deskmates;
    const { bot } = await harness.seed();
    const started: StartRunRequest[] = [];
    harness.provider.onRun(async (req, gw) => {
      started.push(req);
      const ended: RunEnded = {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        usage: [],
      };
      await gw.post("ended", ended);
    });
    const run = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "tiers",
      triggerPayload: { body: "test" },
      config: ctx.runConfig(),
    });
    scheduler.tick();
    await waitFor(() => started.length === 1, 3000, "run started");
    return { req: started[0] as StartRunRequest, runId: run.id };
  }

  it("sends nothing and records nothing without overrides", async () => {
    h = await startHarness();
    const { req, runId } = await startOnce(h);
    expect("toolTierOverrides" in req).toBe(false);
    expect("toolTierOverrides" in h.app.deskmates.ctx.runs.mustGet(runId as never).config).toBe(
      false,
    );
  });

  it("sends the overrides and records them on the row", async () => {
    h = await startHarness();
    const { ctx } = h.app.deskmates;
    // The seed's workspace is the first one the harness creates; set its override before the run.
    const original = h.seed.bind(h);
    h.seed = async (options) => {
      const seeded = await original(options);
      new ToolTierOverrides(ctx.db).set(seeded.workspace.id, "Agent", "L2", "user:test");
      return seeded;
    };
    const { req, runId } = await startOnce(h);
    expect(req.toolTierOverrides).toEqual({ Agent: "L2" });
    expect(ctx.runs.mustGet(runId as never).config.toolTierOverrides).toEqual({ Agent: "L2" });
  });

  it("keeps the first start's record on a resume and never adds newer overrides", () => {
    const db = openDatabase(":memory:");
    try {
      const ctx = buildContext(testConfig(), db, new FakeProvider(), () => "http://gateway.test");
      const ws = ctx.workspaces.create({ name: "t", sandboxProvider: "docker" });
      const bot = ctx.bots.create({ name: "b", role: "worker", workspaceId: ws.id });
      const create = () =>
        ctx.runs.create({
          botId: bot.id,
          lane: "background",
          triggerKind: "webhook",
          triggerRef: "t",
          triggerPayload: { body: "x" },
          config: ctx.runConfig(),
        });
      const wsId = ws.id as WorkspaceId;
      const store = new ToolTierOverrides(db);

      // Started with none, parked, then an operator adds one: the resume still sends none.
      const plain = create();
      expect(toolTierStart(db, ctx.runs, plain, wsId, { resume: false })).toEqual({});
      store.set(wsId, "Bash", "L1", "user:test");
      expect(
        toolTierStart(db, ctx.runs, ctx.runs.mustGet(plain.id), wsId, { resume: true }),
      ).toEqual({});

      // Started with one, parked, then the operator changes it: the resume sends the first one.
      const frozen = create();
      expect(toolTierStart(db, ctx.runs, frozen, wsId, { resume: false })).toEqual({
        toolTierOverrides: { Bash: "L1" },
      });
      store.set(wsId, "Bash", "L2", "user:test");
      store.set(wsId, "Agent", "L2", "user:test");
      expect(
        toolTierStart(db, ctx.runs, ctx.runs.mustGet(frozen.id), wsId, { resume: true }),
      ).toEqual({ toolTierOverrides: { Bash: "L1" } });
    } finally {
      db.close();
    }
  });
});
