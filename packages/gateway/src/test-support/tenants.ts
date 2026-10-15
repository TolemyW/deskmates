// T1 fixture for ADR-0022 tenant-boundary tests: a tenant with one row of every tenant-owned
// kind, sentinel text that is easy to find in any response, and a signed-in Owner. Two calls
// give tenants A and B whose identifiers can be swapped into each other's requests.

import { createHash } from "node:crypto";
import type { ApprovalId, BotId, RunId, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { skillHashInput, skillMarkdown } from "@deskmates/contracts";
import { csrfTokenFor } from "../auth/tokens.js";
import type { GatewayContext } from "../context.js";
import { IntegrationStore } from "../integrations/integration-store.js";
import type { OwnedKind } from "../tenancy/ownership.js";

export const FIXTURE_PASSWORD = "a long enough fixture password";

export interface TenantFixture {
  tenantId: string;
  /** Unique text planted in every row this tenant owns. */
  sentinel: string;
  ownerUserId: string;
  /** Session cookie value and its CSRF token for the tenant's Owner. */
  token: string;
  csrf: string;
  ids: Record<OwnedKind, string> & { task: string };
}

let counter = 0;

/**
 * Seed one tenant. `tenantId` defaults to a new tenant; pass `tnt_default` to fill the Default
 * Tenant. The Owner signs in with the fixture password.
 */
export async function seedTenant(
  ctx: GatewayContext,
  label: string,
  tenantId?: string,
): Promise<TenantFixture> {
  counter += 1;
  const sentinel = `sentinel${label}${counter}x`;
  const tenant = tenantId ?? ctx.auth.users.createTenant({ name: `Tenant ${label}` }).id;
  const loginName = `owner-${label.toLowerCase()}-${counter}`;
  const owner = await ctx.auth.createUser({
    loginName,
    displayName: `Owner ${label}`,
    password: FIXTURE_PASSWORD,
    role: "owner",
    tenantId: tenant,
  });
  const { token } = await ctx.auth.login(loginName, FIXTURE_PASSWORD, `fixture-${label}`);

  const workspace = ctx.workspaces.create({
    tenantId: tenant,
    name: `${sentinel} workspace`,
    sandboxProvider: "docker",
    egressAllowlist: ["*.example.test"],
    // The fixture's Owner created it, so it is that workspace's Owner (ADR-0031 decision 7).
    ownerUserId: owner.id,
  });
  const bot = ctx.bots.create({
    name: `${sentinel.toLowerCase()}bot`,
    role: `${sentinel} role`,
    workspaceId: workspace.id as WorkspaceId,
  });
  const thread = ctx.threads.create({
    workspaceId: workspace.id as WorkspaceId,
    botIds: [bot.id as BotId],
    title: `${sentinel} thread`,
  });
  const run = ctx.runs.create({
    botId: bot.id as BotId,
    threadId: thread.id as ThreadId,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: `${sentinel}-trigger`,
    config: ctx.runConfig(),
  });
  const approval = ctx.approvals.create({
    id: `apr_${sentinel}` as ApprovalId,
    runId: run.id as RunId,
    botId: bot.id as BotId,
    threadId: thread.id as ThreadId,
    action: { toolName: "Bash", input: { command: `echo ${sentinel}` } },
    riskLevel: "L2",
    instruction: `${sentinel} instruction`,
  });
  const rule = ctx.rules.create({
    botId: bot.id as BotId,
    matcher: { toolName: "Bash", argumentPattern: `echo ${sentinel}*` },
    decision: "deny",
    createdBy: "human:fixture",
  });
  const entry = ctx.memory.entries.insert({
    workspaceId: workspace.id as WorkspaceId,
    scope: "workspace",
    kind: "note",
    body: `${sentinel} remembered fact`,
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    by: "human:fixture",
  });
  const suggestion = ctx.memory.confirmations.gate({
    workspaceId: workspace.id as WorkspaceId,
    runId: run.id as RunId,
    botId: bot.id as BotId,
    threadId: thread.id as ThreadId,
    ordinal: 1,
    body: `${sentinel} suggested fact`,
    proposedScope: "workspace",
    authority: "fact",
    trust: "untrusted",
    sourceKind: "bot_self",
    reasons: [],
  });
  const costRule = ctx.costAlerts.createRule(tenant, {
    kind: "unpriced_usage",
    window: "day",
    botId: bot.id as BotId,
    createdBy: "human:fixture",
  });
  const costAlertId = `cal_${sentinel}`;
  ctx.db
    .prepare(
      `INSERT INTO cost_alerts (id, workspace_id, rule_id, kind, window_kind, window_key, bot_id,
         threshold_usd, run_id, run_count, usage_count, input_tokens, output_tokens,
         cache_read_tokens, cache_create_tokens, priced_usage_count, unpriced_usage_count,
         known_cost_usd, fired_at)
       VALUES (?, ?, ?, 'unpriced_usage', 'day', '2026-10-05', ?, NULL, ?, 1, 1, 1, 1, 0, 0, 0, 1, NULL, ?)`,
    )
    .run(costAlertId, workspace.id, costRule.id, bot.id, run.id, new Date().toISOString());
  const connector = ctx.connectors.register({
    workspaceId: workspace.id as WorkspaceId,
    name: `${sentinel}conn`,
    url: "https://connector.example.test/",
    publicUrl: true,
  });
  const proposal = ctx.knowledge.propose(tenant, `${sentinel} title`, `${sentinel} body text`);
  const published = ctx.knowledge.propose(tenant, `${sentinel} doc`, `${sentinel} published body`);
  const doc = ctx.knowledge.review(tenant, published.id, "approve", "human:fixture");
  const integration = new IntegrationStore(ctx.db).insertConnection({
    workspaceId: workspace.id as WorkspaceId,
    service: "github",
    connectionName: `${sentinel}gh`,
    runtimeConnectionName: `${sentinel}-runtime`,
    runtimeConnectionId: `${sentinel}-rid`,
    authKind: "api_key",
  });
  const task = ctx.tasks.create(workspace.id as WorkspaceId, { title: `${sentinel} task` });
  const servicePrincipal = ctx.auth.servicePrincipals.create(
    tenant,
    { name: `${sentinel} agent` },
    "human:fixture",
    "member",
  ).record;
  const skillFiles = [
    {
      path: "SKILL.md",
      content: skillMarkdown({
        name: `${sentinel.toLowerCase()}-skill`,
        description: `${sentinel} skill description`,
        body: `${sentinel} skill steps`,
      }),
    },
  ];
  const skill = ctx.skills.install(
    workspace.id as WorkspaceId,
    {
      files: skillFiles,
      sha256: createHash("sha256").update(skillHashInput(skillFiles)).digest("hex"),
      botIds: [bot.id as BotId],
    },
    "human:fixture",
  ).skill;
  return {
    tenantId: tenant,
    sentinel,
    ownerUserId: owner.id,
    token,
    csrf: csrfTokenFor(token),
    ids: {
      workspace: workspace.id,
      bot: bot.id,
      thread: thread.id,
      run: run.id,
      approval: approval.id,
      approvalRule: rule.id,
      memoryEntry: entry.id,
      memorySuggestion: suggestion.id,
      costAlertRule: costRule.id,
      costAlert: costAlertId,
      connector: connector.id,
      knowledgeDoc: doc.documentId as string,
      knowledgeProposal: proposal.id,
      integrationConnection: integration.id,
      servicePrincipal: servicePrincipal.id,
      skill: skill.id,
      task: task.id,
    },
  };
}

/** Every row of every table, for "no side effect" assertions. */
export function snapshotDatabase(ctx: GatewayContext): string {
  const tables = (
    ctx.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  return JSON.stringify(
    tables
      // Sessions slide their idle expiry on use; that bookkeeping is not a side effect. Nor is
      // a Costs read filling the run usage summary cache (ADR-0032 amendment 1 decision 12).
      .filter(
        (name) =>
          name !== "auth_sessions" &&
          name !== "run_usage_summaries" &&
          name !== "run_usage_summary_models",
      )
      .map((name) => [name, ctx.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
  );
}
