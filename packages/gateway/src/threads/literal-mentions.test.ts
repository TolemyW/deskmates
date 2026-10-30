// T1: actual routing/stores and private handoffs, no model or sandbox process.
import type { GroupRouting } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { type GatewayDb, openDatabase } from "../db/open.js";
import type { RunRecord } from "../ledger/runs.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { routePrivateMentions } from "./private-mentions.js";

function requireRun(run: RunRecord | undefined): RunRecord {
  if (!run) throw new Error("expected a queued run");
  return run;
}

const databases: GatewayDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(groupRouting: GroupRouting = "owner-v1") {
  const db = openDatabase(":memory:");
  databases.push(db);
  const ctx = buildContext(
    testConfig({ groupRouting }),
    db,
    new FakeProvider(),
    () => "http://gateway.test",
  );
  const workspace = ctx.workspaces.create({ name: "literal mentions", sandboxProvider: "docker" });
  const author = ctx.bots.create({ name: "author", role: "reviewer", workspaceId: workspace.id });
  const peer = ctx.bots.create({ name: "peer", role: "engineer", workspaceId: workspace.id });
  const other = ctx.bots.create({ name: "other", role: "engineer", workspaceId: workspace.id });
  return { ctx, workspace, author, peer, other };
}

describe("literal mention routing (ADR-0056)", () => {
  it.each(["owner-v1", "walk-v1", "round-v1"] as const)(
    "%s retains reports without fan-out and still permits an explicit broadcast",
    (mode) => {
      const s = setup(mode);
      const thread = s.ctx.threads.create({
        workspaceId: s.workspace.id,
        botIds: [s.author.id, s.peer.id, s.other.id],
      });
      const first = s.ctx.router.postHuman({ threadId: thread.id, body: "@author diagnose" });
      const run = s.ctx.runs.transition(requireRun(first.runs[0]).id, "running", {
        deliveredSeq: first.message.seq,
      });
      const body = "考虑但排除（成员名 ASCII 限制、@everyone 丢提及、测试密度）。";
      const posted = s.ctx.router.postFromRunRouted(run, body);
      expect(posted.message.body).toBe(body);
      expect(posted.message.mentions).toEqual([]);
      expect(s.ctx.runs.list({ threadId: thread.id })).toHaveLength(mode === "walk-v1" ? 2 : 1);
      // The opt-in legacy walk keeps its ordinary serial unaddressed wake.

      s.ctx.router.postFromRun(run, "@everyone please review the findings");
      const queued = s.ctx.runs.list({ threadId: thread.id }).filter((r) => r.status === "queued");
      expect(queued.map((r) => r.botId).sort()).toEqual([s.peer.id, s.other.id].sort());
    },
  );

  it("does not join a human's quoted teammate or reject a quoted cross-workspace name", () => {
    const s = setup();
    const outsideWorkspace = s.ctx.workspaces.create({
      name: "other workspace",
      sandboxProvider: "docker",
    });
    s.ctx.bots.create({ name: "outside", role: "other", workspaceId: outsideWorkspace.id });
    const thread = s.ctx.threads.create({ workspaceId: s.workspace.id, botIds: [s.author.id] });
    const body = "Examples: `@peer` and `@outside`; \\@peer is literal too.";
    expect(s.ctx.router.mentionsThatJoin(thread.id, body)).toEqual([]);
    const posted = s.ctx.router.postHuman({ threadId: thread.id, body });
    expect(posted.message.body).toBe(body);
    expect(posted.message.mentions).toEqual([]);
    expect(s.ctx.threads.members(thread.id).map((m) => m.botId)).toEqual([s.author.id]);
    expect(posted.runs.map((r) => r.botId)).toEqual([s.author.id]);
  });

  it("does not attempt private handoffs for examples but still reports a real blocked handoff", () => {
    const s = setup();
    const thread = s.ctx.threads.create({ workspaceId: s.workspace.id, botIds: [s.author.id] });
    const first = s.ctx.router.postHuman({ threadId: thread.id, body: "Explain handoffs" });
    const run = s.ctx.runs.transition(requireRun(first.runs[0]).id, "running", {
      deliveredSeq: first.message.seq,
    });
    const report = s.ctx.router.postFromRun(run, "Example: `@peer`, `@missing`, and \\@peer.");
    routePrivateMentions(s.ctx, run, report);
    expect(s.ctx.privateChats.results(report.id)).toEqual([]);
    const handoff = s.ctx.router.postFromRun(run, "Please ask @peer to review");
    routePrivateMentions(s.ctx, run, handoff);
    expect(s.ctx.privateChats.results(handoff.id)).toHaveLength(1);
    expect(s.ctx.messages.list(thread.id).at(-1)?.body).toContain("not configured");
  });
});
