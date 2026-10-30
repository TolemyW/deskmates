// Credential use (ADR-0045 decisions 4 to 8). A run asks for a use by reference; the Gateway
// derives the workspace from the run, rechecks the entry, requires the approval that released this
// use and spends it once, checks the browser admission state, and only then decrypts. A browser
// fill goes through the fixed `deskmates-sidecar vault-fill` command with the value on stdin; a
// token goes into one bounded host-side request. Every use is one `vault_uses` row with its typed
// outcome and the answer the tool got; a repeat with the same approval returns that answer, and a
// use left `in_flight` (the Gateway stopped mid-use) is reported as unknown, never executed again.
//
// Nothing here makes a filled value private inside the workspace (decision 9): it is in the shared
// browser, where page scripts and any bot with shell or CDP access can read it.

import {
  type ApprovalId,
  type BotId,
  DeskmatesError,
  VAULT_FILL_COMMAND,
  VAULT_FILL_TOOL,
  VAULT_REQUEST_TOOL,
  VAULT_USE_STATUSES,
  type VaultFillCommandInput,
  type VaultFillStatus,
  type VaultFillUseRequest,
  type VaultListing,
  type VaultOperation,
  type VaultRequestUseRequest,
  type VaultToolEntry,
  type VaultUseRequest,
  type VaultUseResult,
  type VaultUseStatus,
  type WorkspaceId,
  vaultActionPattern,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { newId } from "../db/ids.js";
import type { RunRecord } from "../ledger/runs.js";
import { type VaultHttpDeps, vaultHttpRequest } from "./http-use.js";
import { VAULT_STATUS_MESSAGES, vaultStatusOk } from "./messages.js";
import { type VaultEntryRecord, vaultStore } from "./store.js";
import { paramsProblem } from "./validate.js";

export type VaultUseDeps = Pick<
  GatewayContext,
  | "db"
  | "secrets"
  | "approvals"
  | "runs"
  | "bots"
  | "events"
  | "locks"
  | "sandboxes"
  | "provider"
  | "workspaces"
>;

const FILL_TIMEOUT_MS = 15_000;
const FILL_STATUSES: ReadonlySet<string> = new Set<VaultFillStatus>([
  "filled",
  "target_mismatch",
  "frame_mismatch",
  "stale_tab",
  "missing_fields",
  "ambiguous_fields",
  "not_password_field",
  "navigated",
  "fill_failed",
]);
const KNOWN_STATUSES: ReadonlySet<string> = new Set(VAULT_USE_STATUSES);

interface UseRow {
  id: string;
  state: "in_flight" | "done";
  status: string | null;
  result_json: string | null;
}

/** What one use is about, before anything is decrypted. */
interface UseScope {
  run: RunRecord;
  workspaceId: WorkspaceId;
  entry: VaultEntryRecord;
  operation: VaultOperation;
  requestId?: string;
  req: VaultUseRequest;
}

export class VaultUses {
  /** Uses on their way, by approval id, so a concurrent repeat waits instead of executing. */
  private readonly inFlight = new Map<string, Promise<VaultUseResult>>();

  constructor(
    private readonly deps: VaultUseDeps,
    private readonly http: VaultHttpDeps = {},
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private store() {
    return vaultStore(this.deps);
  }

  private workspaceOf(run: RunRecord): WorkspaceId {
    return this.deps.bots.mustGet(run.botId as BotId).workspaceId;
  }

  /** `vault_list` (L0): the usable entries of the run's own workspace, metadata only. */
  list(run: RunRecord): VaultListing {
    const entries = this.store().toolListing(this.workspaceOf(run));
    return entries.length > 0
      ? { entries }
      : {
          entries,
          note: "This workspace's Vault has no usable credentials. Ask an Owner or Admin to add one; never ask for a password in chat.",
        };
  }

  /** What the PreToolUse hook tiers and describes a use by; 404 for another workspace's entry. */
  facts(run: RunRecord, entryId: string): VaultToolEntry & { enabled: boolean } {
    const workspaceId = this.workspaceOf(run);
    const entry = this.store().record(workspaceId, entryId);
    if (!entry) throw new DeskmatesError("not_found", "Vault entry not found");
    const listed = this.store()
      .toolListing(workspaceId)
      .find((e) => e.id === entryId);
    return {
      ...(listed ?? {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        targetOrigin: entry.targetOrigin,
        revision: entry.revision,
      }),
      enabled: listed !== undefined,
    };
  }

  private result(
    scope: Pick<UseScope, "entry" | "operation" | "requestId" | "req">,
    status: VaultUseStatus,
    extra: Partial<VaultUseResult> = {},
  ): VaultUseResult {
    return {
      status,
      ok: vaultStatusOk(status),
      entryId: scope.req.entryId,
      revision: scope.req.revision,
      operation: scope.operation,
      ...(scope.requestId === undefined ? {} : { requestId: scope.requestId }),
      message: VAULT_STATUS_MESSAGES[status],
      ...extra,
    };
  }

  /** The ledger line of a use: references and the outcome, never a value (decision 7). */
  private log(run: RunRecord, scope: UseScope | undefined, payload: Record<string, unknown>) {
    this.deps.events.append({
      runId: run.id,
      kind: "log",
      payload: {
        source: "vault",
        ...(scope
          ? {
              entryId: scope.entry.id,
              revision: scope.req.revision,
              operation: scope.operation,
              ...(scope.requestId === undefined ? {} : { requestId: scope.requestId }),
              target: scope.entry.targetOrigin,
              approvalId: scope.req.approvalId,
            }
          : {}),
        ...payload,
      },
    });
  }

  /** Checks that need no grant and decrypt nothing; a refusal here spends no approval. */
  private precheck(
    run: RunRecord,
    req: VaultUseRequest,
    operation: VaultOperation,
    requestId: string | undefined,
  ): UseScope | VaultUseResult {
    const workspaceId = this.workspaceOf(run);
    const entry = this.store().record(workspaceId, req.entryId);
    const bare = {
      entry: { id: req.entryId } as VaultEntryRecord,
      operation,
      ...(requestId === undefined ? {} : { requestId }),
      req,
    };
    if (!entry) return this.result(bare, "not_found");
    const scope: UseScope = {
      run,
      workspaceId,
      entry,
      operation,
      ...(requestId === undefined ? {} : { requestId }),
      req,
    };
    const wanted = operation === "fill" ? "browser_login" : "http_header_token";
    if (entry.type !== wanted) return this.result(scope, "wrong_type");
    if (!entry.enabled) return this.result(scope, "disabled");
    if (entry.revision !== req.revision) return this.result(scope, "revision_mismatch");
    if (!this.store().available) return this.result(scope, "vault_unavailable");
    if (operation === "request" && !entry.requests.some((r) => r.id === requestId))
      return this.result(scope, "request_not_found");
    return scope;
  }

  /**
   * Decision 4: the approval that released this use. It is this run's, decided allow, for this
   * tool on the entry's exact origin and the exact `vault:<id> rev:<n> op:<operation>` action.
   * Storing a value grants nothing: without such a row there is no use.
   */
  private granted(scope: UseScope): boolean {
    const approval = this.deps.approvals.get(scope.req.approvalId as ApprovalId);
    if (!approval || approval.runId !== scope.run.id) return false;
    if (approval.decision !== "allow_once" && approval.decision !== "allow_always") return false;
    const tool = scope.operation === "fill" ? VAULT_FILL_TOOL : VAULT_REQUEST_TOOL;
    const pattern = vaultActionPattern({
      entryId: scope.entry.id,
      revision: scope.req.revision,
      operation: scope.operation,
      ...(scope.requestId === undefined ? {} : { requestId: scope.requestId }),
    });
    return (
      approval.action.toolName === tool &&
      approval.action.targetOrigin === scope.entry.targetOrigin &&
      approval.action.argumentPattern === pattern
    );
  }

  private recorded(runId: string, approvalId: string, toolUseId: string): UseRow | undefined {
    return this.deps.db
      .prepare(
        `SELECT id, state, status, result_json FROM vault_uses
          WHERE run_id = ? AND (approval_id = ? OR tool_use_id = ?)`,
      )
      .get(runId, approvalId, toolUseId) as UseRow | undefined;
  }

  private begin(scope: UseScope): string {
    const id = newId("vus");
    this.deps.db
      .prepare(
        `INSERT INTO vault_uses (id, workspace_id, entry_id, revision, run_id, attempt, approval_id,
           tool_use_id, operation, request_id, target, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?)`,
      )
      .run(
        id,
        scope.workspaceId,
        scope.entry.id,
        scope.req.revision,
        scope.run.id,
        scope.run.attempt,
        scope.req.approvalId,
        scope.req.toolUseId,
        scope.operation,
        scope.requestId ?? null,
        scope.entry.targetOrigin,
        this.clock().toISOString(),
      );
    return id;
  }

  private finish(useId: string, result: VaultUseResult): void {
    this.deps.db
      .prepare(
        `UPDATE vault_uses SET state = 'done', status = ?, http_status = ?, result_json = ?,
           finished_at = ? WHERE id = ?`,
      )
      .run(
        result.status,
        result.httpStatus ?? null,
        JSON.stringify(result),
        this.clock().toISOString(),
        useId,
      );
  }

  /** The shared pipeline: precheck, grant, one row, release, outcome. */
  private async use(
    run: RunRecord,
    req: VaultUseRequest,
    operation: VaultOperation,
    requestId: string | undefined,
    release: (scope: UseScope) => Promise<VaultUseResult>,
  ): Promise<VaultUseResult> {
    const checked = this.precheck(run, req, operation, requestId);
    if (!("run" in checked)) {
      this.log(run, undefined, {
        entryId: req.entryId,
        operation,
        approvalId: req.approvalId,
        status: checked.status,
      });
      return checked;
    }
    const scope = checked;
    const waiting = this.inFlight.get(req.approvalId);
    if (waiting) return { ...(await waiting), recorded: true };
    const previous = this.recorded(run.id, req.approvalId, req.toolUseId);
    if (previous) {
      if (previous.state === "in_flight") {
        // The Gateway stopped during this use (decision 6): its outcome is unknown, for good.
        const unknown = this.result(scope, "unknown", { recorded: true });
        this.finish(previous.id, unknown);
        this.log(run, scope, { status: "unknown", phase: "interrupted" });
        return unknown;
      }
      const answer = previous.result_json
        ? (JSON.parse(previous.result_json) as VaultUseResult)
        : undefined;
      if (answer && KNOWN_STATUSES.has(answer.status)) return { ...answer, recorded: true };
      return this.result(scope, "unknown", { recorded: true });
    }
    if (!this.granted(scope)) {
      this.log(run, scope, { status: "no_grant" });
      return this.result(scope, "no_grant");
    }
    const useId = this.begin(scope);
    const work = (async () => {
      let result: VaultUseResult;
      try {
        result = await release(scope);
      } catch {
        result = this.result(scope, operation === "fill" ? "fill_failed" : "unknown");
      }
      this.finish(useId, result);
      this.log(run, scope, {
        status: result.status,
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
      });
      return result;
    })();
    this.inFlight.set(req.approvalId, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(req.approvalId);
    }
  }

  /** `vault_fill` (decision 5). */
  fill(run: RunRecord, req: VaultFillUseRequest): Promise<VaultUseResult> {
    return this.use(run, req, "fill", undefined, async (scope) => {
      const { locks } = this.deps;
      if (locks.humanHolds(scope.workspaceId)) return this.result(scope, "takeover");
      const leases = locks.list(scope.workspaceId);
      if (
        leases.some(
          (l) => l.holderKind === "run" && l.holderRunId !== run.id && l.tabId === req.tabId,
        ) ||
        leases.some(
          (l) =>
            l.holderKind === "run" &&
            l.holderRunId === run.id &&
            l.tabId !== undefined &&
            l.tabId !== req.tabId,
        )
      )
        return this.result(scope, "stale_tab");
      const handle = await this.deps.sandboxes.peek(scope.workspaceId);
      if (!handle) return this.result(scope, "workspace_not_running");
      const epoch = locks.epoch(scope.workspaceId);
      const payload = this.store().payload(scope.workspaceId, scope.entry.id, req.revision);
      if (!payload || !("password" in payload)) return this.result(scope, "disabled");
      const input: VaultFillCommandInput = {
        tabId: req.tabId,
        origin: scope.entry.targetOrigin,
        ...(req.frameUrl ? { frameUrl: req.frameUrl } : {}),
        ...(req.usernameField ? { usernameField: req.usernameField } : {}),
        ...(req.passwordField ? { passwordField: req.passwordField } : {}),
        username: payload.username,
        password: payload.password,
      };
      let status: VaultUseStatus = "fill_failed";
      try {
        // The value travels on stdin only: never a shell string, an argument or a file.
        const out = await this.deps.provider.exec(handle, {
          cmd: VAULT_FILL_COMMAND,
          stdin: JSON.stringify(input),
          timeoutMs: FILL_TIMEOUT_MS,
        });
        const last = out.stdout.trim().split("\n").at(-1) ?? "";
        const parsed = JSON.parse(last) as { status?: unknown };
        if (!out.timedOut && typeof parsed.status === "string" && FILL_STATUSES.has(parsed.status))
          status = parsed.status as VaultUseStatus;
      } catch {
        status = "fill_failed";
      }
      // Decision 5: a takeover during the fill invalidates it, whatever the command said.
      if (locks.humanHolds(scope.workspaceId) || locks.epoch(scope.workspaceId) !== epoch)
        status = "takeover";
      return this.result(scope, status);
    });
  }

  /** `vault_request` (decision 6). */
  request(run: RunRecord, req: VaultRequestUseRequest): Promise<VaultUseResult> {
    return this.use(run, req, "request", req.requestId, async (scope) => {
      const definition = scope.entry.requests.find((r) => r.id === req.requestId);
      if (!definition) return this.result(scope, "request_not_found");
      const problem = paramsProblem(definition, req.params);
      if (problem) return this.result(scope, "invalid_params", { message: problem });
      const payload = this.store().payload(scope.workspaceId, scope.entry.id, req.revision);
      if (!payload || !("token" in payload)) return this.result(scope, "disabled");
      const outcome = await vaultHttpRequest(this.http, {
        origin: scope.entry.targetOrigin,
        definition,
        params: req.params,
        token: payload.token,
        egressAllowlist: this.deps.workspaces.mustGet(scope.workspaceId).egressAllowlist,
      });
      return this.result(scope, outcome.status, {
        ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
        ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
        ...(outcome.body === undefined ? {} : { body: outcome.body }),
        ...(outcome.bodyTruncated ? { bodyTruncated: true as const } : {}),
      });
    });
  }
}

const services = new WeakMap<object, VaultUses>();

/** The use service of a Gateway context, built on first use (the context is a hotspot). */
export function vaultUses(ctx: VaultUseDeps & { vaultHttp?: VaultHttpDeps }): VaultUses {
  let service = services.get(ctx.db);
  if (!service) {
    service = new VaultUses(ctx, ctx.vaultHttp ?? {});
    services.set(ctx.db, service);
  }
  return service;
}

/** Tests replace the HTTP side of a context's use service before its first use. */
export function setVaultHttp(ctx: VaultUseDeps, http: VaultHttpDeps): VaultUses {
  const service = new VaultUses(ctx, http);
  services.set(ctx.db, service);
  return service;
}
