// Test fixture for the workspace Vault (ADR-0045): a Gateway with a secrets key, two workspaces
// with a thread, two bots and one running run each, and helpers to call the run routes with the
// run's own token and to obtain the approval a credential release needs. Synthetic secrets only.

import {
  type ApprovalId,
  type ApprovalMode,
  type ApprovalResponse,
  type BotDefinition,
  type Thread,
  type ToolAction,
  VAULT_FILL_TOOL,
  VAULT_REQUEST_TOOL,
  type VaultEntry,
  type Workspace,
  vaultActionPattern,
} from "@deskmates/contracts";
import type { RunRecord } from "../ledger/runs.js";
import { TEST_SECRETS_KEY } from "./connector-fixture.js";
import { type Harness, startHarness } from "./harness.js";

export const CANARY_USER = "synthetic-vault-user-4c1e";
export const CANARY_PASSWORD = "synthetic-vault-password-9b7d";
export const CANARY_TOKEN = "synthetic-vault-token-2a6f";
export const ORIGIN = "https://console.example.test";
export const API_ORIGIN = "https://api.example.test";

export interface VaultSide {
  workspace: Workspace;
  thread: Thread;
  bot: BotDefinition;
  teammate: BotDefinition;
  run: RunRecord;
  token: string;
}

export interface VaultFixture {
  h: Harness;
  a: VaultSide;
  b: VaultSide;
  /** A run route of `side`'s run, with `token` (its own by default). */
  run<T>(
    side: VaultSide,
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: T }>;
  login(side: VaultSide, extra?: Record<string, unknown>): Promise<VaultEntry>;
  tokenEntry(side: VaultSide, effect?: "read" | "write"): Promise<VaultEntry>;
  /** The action the sidecar's hook posts for a release of `entry`. */
  action(entry: VaultEntry, operation: "fill" | "request", requestId?: string): ToolAction;
  /** Post the approval request as `side`'s run; decide it as a human unless `decide` is false. */
  approve(
    side: VaultSide,
    action: ToolAction,
    decide?: "allow_once" | "allow_always" | "deny" | false,
  ): Promise<{ approvalId: ApprovalId; response: ApprovalResponse | undefined }>;
  mode(side: VaultSide, mode: ApprovalMode): void;
  close(): Promise<void>;
}

let approvals = 0;

export async function vaultFixture(
  options: { secretsKey?: string; mode?: ApprovalMode } = {},
): Promise<VaultFixture> {
  const h = await startHarness({ secretsKey: options.secretsKey ?? TEST_SECRETS_KEY });
  h.app.deskmates.scheduler.stop();
  const ctx = h.app.deskmates.ctx;
  const side = (name: string): VaultSide => {
    const workspace = ctx.workspaces.create({
      name,
      sandboxProvider: "docker",
      egressAllowlist: ["*.example.test"],
    });
    ctx.db
      .prepare("UPDATE workspaces SET approval_mode = ? WHERE id = ?")
      .run(options.mode ?? "manual", workspace.id);
    const bot = ctx.bots.create({ name: `${name}-bot`, role: "ops", workspaceId: workspace.id });
    const teammate = ctx.bots.create({
      name: `${name}-mate`,
      role: "ops",
      workspaceId: workspace.id,
    });
    const thread = ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id, teammate.id] });
    const created = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "vault-test",
      config: ctx.runConfig(),
    });
    const run = ctx.runs.transition(created.id, "running");
    return { workspace, thread, bot, teammate, run, token: ctx.tokens.issue(run.id).token };
  };
  const a = side("vault-a");
  const b = side("vault-b");

  const call = async <T>(
    s: VaultSide,
    method: string,
    path: string,
    body?: unknown,
    token = s.token,
  ) => {
    const res = await fetch(`${h.baseUrl}/internal/runs/${s.run.id}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (text === "" ? undefined : JSON.parse(text)) as T };
  };

  const create = async (s: VaultSide, body: Record<string, unknown>) => {
    const res = await h.api<{ entry: VaultEntry }>(
      "POST",
      `/api/workspaces/${s.workspace.id}/vault`,
      body,
    );
    if (res.status !== 201) throw new Error(`create: ${JSON.stringify(res.json)}`);
    return res.json.entry;
  };

  return {
    h,
    a,
    b,
    run: call,
    login: (s, extra = {}) =>
      create(s, {
        name: "Console",
        type: "browser_login",
        targetOrigin: ORIGIN,
        username: CANARY_USER,
        password: CANARY_PASSWORD,
        ...extra,
      }),
    tokenEntry: async (s, effect = "read") => {
      const entry = await create(s, {
        name: "Items API",
        type: "http_header_token",
        targetOrigin: API_ORIGIN,
        token: CANARY_TOKEN,
      });
      const res = await h.api<{ entry: VaultEntry }>(
        "PUT",
        `/api/workspaces/${s.workspace.id}/vault/${entry.id}/requests`,
        {
          expectedRevision: entry.revision,
          requests: [
            {
              name: "Get item",
              method: effect === "read" ? "GET" : "POST",
              path: "/v1/items/{id}",
              params: [
                { name: "id", in: "path", type: "string" },
                ...(effect === "read"
                  ? [{ name: "q", in: "query", type: "string" }]
                  : [{ name: "note", in: "body", type: "string" }]),
              ],
              header: { scheme: "bearer" },
              effect,
            },
          ],
        },
      );
      if (res.status !== 200) throw new Error(`requests: ${JSON.stringify(res.json)}`);
      return res.json.entry;
    },
    action: (entry, operation, requestId) => {
      const pattern = vaultActionPattern({
        entryId: entry.id,
        revision: entry.revision,
        operation,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return {
        toolName: operation === "fill" ? VAULT_FILL_TOOL : VAULT_REQUEST_TOOL,
        input: { entryId: entry.id, revision: entry.revision, operation },
        targetOrigin: entry.targetOrigin,
        argumentSummary: pattern,
        argumentPattern: pattern,
      };
    },
    approve: async (s, action, decide = "allow_once") => {
      approvals += 1;
      const approvalId = `apr_vault_${approvals}` as ApprovalId;
      const posted = await call<ApprovalResponse>(s, "POST", "/approvals", {
        type: "approval_request",
        runId: s.run.id,
        approvalId,
        action,
        riskLevel: "L2",
        toolUseId: `toolu_${approvals}`,
      });
      if (posted.status !== 200 && posted.status !== 202)
        throw new Error(`approval: ${JSON.stringify(posted.json)}`);
      const current = ctx.approvals.mustGet(approvalId);
      if (decide !== false && current.decision === undefined)
        ctx.broker.decide(approvalId, decide, "human:tester");
      return { approvalId, response: posted.status === 200 ? posted.json : undefined };
    },
    mode: (s, mode) =>
      void ctx.db
        .prepare("UPDATE workspaces SET approval_mode = ? WHERE id = ?")
        .run(mode, s.workspace.id),
    close: () => h.close(),
  };
}

/** The toolUseId the fixture's `approve` gave its n-th approval, for a use request. */
export function toolUseOf(approvalId: ApprovalId): string {
  return `toolu_${approvalId.replace("apr_vault_", "")}`;
}
