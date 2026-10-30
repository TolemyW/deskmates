// T1: the audit record (ADR-0031 decision 11). Every approval decision and every listed
// workspace-level configuration change writes exactly one row in its own transaction; personal
// preferences write none; no value carries a secret; the record outlives a purged workspace.

import type { BotDefinition, BotId, RunId, Workspace } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { AuditLog, redactAuditValue } from "./audit-log.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  if (h) await h.close();
});

async function setup(): Promise<{ workspace: Workspace; bot: BotDefinition }> {
  const created = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    defaultBot: false,
    name: "Audited",
    egressAllowlist: ["example.test"],
  });
  const bot = await h.api<{ bot: BotDefinition }>("POST", "/api/bots", {
    name: "audited-bot",
    workspaceId: created.json.workspace.id,
  });
  return { workspace: created.json.workspace, bot: bot.json.bot };
}

function actions(workspaceId: string): string[] {
  return h.app.deskmates.ctx.audit
    .list({ workspaceId })
    .map((e) => e.action)
    .reverse();
}

describe("audit record (ADR-0031 decision 11)", () => {
  it("records workspace, egress, bot, rule and cost changes with actor, target and before/after", async () => {
    const { workspace, bot } = await setup();
    expect(
      (await h.api("PATCH", `/api/workspaces/${workspace.id}`, { egressAllowlist: ["a.test"] }))
        .status,
    ).toBe(200);
    expect(
      (
        await h.api("PATCH", `/api/bots/${bot.id}`, {
          cron: [{ schedule: "0 9 * * *", prompt: "daily" }],
        })
      ).status,
    ).toBe(200);
    const rule = await h.api<{ rule: { id: string } }>(
      "POST",
      `/api/bots/${bot.id}/approval-rules`,
      { decision: "deny", matcher: { toolName: "Bash" } },
    );
    expect(rule.status).toBe(201);
    expect((await h.api("DELETE", `/api/approval-rules/${rule.json.rule.id}`)).status).toBe(200);
    const cost = await h.api<{ rule: { id: string } }>("POST", "/api/cost-alert-rules", {
      kind: "unpriced_usage",
      window: "day",
      botId: bot.id,
    });
    expect(cost.status).toBe(201);
    expect((await h.api("DELETE", `/api/cost-alert-rules/${cost.json.rule.id}`)).status).toBe(200);

    expect(actions(workspace.id)).toEqual([
      "workspace.create",
      "bot.create",
      "egress.allowlist_set",
      "bot.update",
      "approval_rule.create",
      "approval_rule.delete",
      "cost_rule.create",
      "cost_rule.delete",
    ]);
    const egress = h.app.deskmates.ctx.audit
      .list({ workspaceId: workspace.id })
      .find((e) => e.action === "egress.allowlist_set");
    expect(egress).toMatchObject({
      actor: "human:web",
      targetKind: "workspace",
      targetId: workspace.id,
      before: { egressAllowlist: ["example.test"] },
      after: { egressAllowlist: ["a.test"] },
    });
    const update = h.app.deskmates.ctx.audit
      .list({ workspaceId: workspace.id })
      .find((e) => e.action === "bot.update");
    expect(update?.before).toEqual({ cron: [] });
    expect(update?.after).toEqual({ cron: [{ schedule: "0 9 * * *", prompt: "daily" }] });
  });

  it("records each approval decision once, a person's, a bot's or a rule's", async () => {
    const { workspace, bot } = await setup();
    const { ctx } = h.app.deskmates;
    const run = ctx.runs.create({
      botId: bot.id as BotId,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "audit",
    });
    const action = { toolName: "Bash", input: { command: "curl https://x.test" } };
    ctx.approvals.create({
      id: "apr_1" as never,
      runId: run.id,
      botId: bot.id,
      action,
      riskLevel: "L2",
    });
    ctx.approvals.decide("apr_1" as never, "allow_once", "human:web");
    ctx.approvals.create({
      id: "apr_2" as never,
      runId: run.id,
      botId: bot.id,
      action,
      riskLevel: "L2",
      decision: "deny",
      decidedBy: "rule:rul_x",
    });
    ctx.approvals.create({
      id: "apr_3" as never,
      runId: run.id,
      botId: bot.id,
      action,
      riskLevel: "L2",
    });
    ctx.approvals.decide("apr_3" as never, "deny", `bot:${bot.id}`);
    expect(() => ctx.approvals.decide("apr_3" as never, "allow_once", "human:web")).toThrow();

    const decisions = ctx.audit
      .list({ workspaceId: workspace.id })
      .filter((e) => e.action === "approval.decide")
      .reverse();
    expect(
      decisions.map((e) => [e.targetId, e.actor, (e.after as { decision: string }).decision]),
    ).toEqual([
      ["apr_1", "human:web", "allow_once"],
      ["apr_2", "rule:rul_x", "deny"],
      ["apr_3", `bot:${bot.id}`, "deny"],
    ]);
    expect(decisions[0]?.runId).toBe(run.id as RunId);
  });

  it("writes nothing for a personal preference", async () => {
    const { ctx } = h.app.deskmates;
    const user = await ctx.auth.createUser({
      loginName: "pref-person",
      displayName: "Pref",
      password: "correct horse battery staple",
      role: "member",
    });
    const before = ctx.audit.list().length;
    ctx.auth.users.updatePreferences(user.id, { locale: "de" } as never);
    expect(ctx.audit.list().length).toBe(before);
  });

  it("keeps the lifecycle rows after a purge", async () => {
    const { workspace } = await setup();
    await h.api("POST", `/api/workspaces/${workspace.id}/archive`);
    await h.api("POST", `/api/workspaces/${workspace.id}/restore`);
    await h.api("POST", `/api/workspaces/${workspace.id}/archive`);
    const deleted = await h.api("DELETE", `/api/workspaces/${workspace.id}`, {
      name: workspace.name,
    });
    expect(deleted.status).toBe(200);
    expect(actions(workspace.id)).toEqual([
      "workspace.create",
      "bot.create",
      "workspace.archive",
      "workspace.restore",
      "workspace.archive",
      "workspace.purge",
    ]);
  });

  it("never stores a secret, token, cookie or message body", () => {
    const corpus = {
      apiKey: "sk-live-0123456789",
      nested: { token: "cbt_abcdef", sessionCookie: "deskmates-session=xyz" },
      list: [{ password: "hunter2", clientSecret: "s3cr3t" }],
      body: "a private message",
      name: "kept",
    };
    expect(redactAuditValue(corpus)).toEqual({
      apiKey: "[redacted]",
      nested: { token: "[redacted]", sessionCookie: "[redacted]" },
      list: [{ password: "[redacted]", clientSecret: "[redacted]" }],
      body: "[redacted]",
      name: "kept",
    });
    const log = new AuditLog(h.app.deskmates.ctx.db);
    log.record({
      action: "workspace.update",
      actor: "user:usr_1",
      tenantId: "tnt_default",
      targetKind: "workspace",
      targetId: "ws_x",
      after: corpus,
    });
    const raw = JSON.stringify(h.app.deskmates.ctx.db.prepare("SELECT * FROM audit_events").all());
    for (const secret of ["sk-live", "cbt_abcdef", "xyz", "hunter2", "s3cr3t", "private message"])
      expect(raw).not.toContain(secret);
    expect(log.list({ targetId: "ws_x" })[0]?.actorUserId).toBe("usr_1");
  });
});
