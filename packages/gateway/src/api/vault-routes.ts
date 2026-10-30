// The Vault (ADR-0045). Operator routes are registered inside the operator auth scope, policies in
// `route-policies/vault.ts`: every Member reads metadata, an Owner or Admin of the workspace
// creates, edits, replaces, disables and deletes (decision 2). No route returns a saved value, and
// none exists to reveal or export one (decision 10). Run routes sit under the run-token scope,
// derive the workspace from the run and answer with references and typed outcomes only.

import type {
  RunId,
  VaultFillUseRequest,
  VaultRequestUseRequest,
  VaultUseRequest,
  VaultView,
  WorkspaceId,
} from "@deskmates/contracts";
import { DeskmatesError, isExecuting } from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import { AutoApprovalSettings } from "../approvals/auto-approval.js";
import type { GatewayContext } from "../context.js";
import { vaultStore } from "../vault/store.js";
import { vaultUses } from "../vault/use.js";
import { requestActorId } from "./actor.js";
import { asRecord } from "./validate.js";

interface WorkspaceParams {
  id: string;
}
interface EntryParams {
  id: string;
  entryId: string;
}

/** The body without the actor label; the label is read from the principal or `authorId`. */
function fields(body: unknown): Record<string, unknown> {
  const { authorId: _authorId, ...rest } = asRecord(body);
  return rest;
}

export function registerVaultRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const view = (workspaceId: WorkspaceId): VaultView => {
    const store = vaultStore(ctx);
    return {
      workspaceId,
      available: store.available,
      approvalMode: new AutoApprovalSettings(ctx.db).mode(workspaceId),
      entries: store.list(workspaceId),
    };
  };
  const workspace = (id: string) => ctx.workspaces.mustGet(id as WorkspaceId).id;

  app.get<{ Params: WorkspaceParams }>("/api/workspaces/:id/vault", async (request) => ({
    vault: view(workspace(request.params.id)),
  }));

  app.post<{ Params: WorkspaceParams }>("/api/workspaces/:id/vault", async (request, reply) => {
    const workspaceId = workspace(request.params.id);
    const entry = vaultStore(ctx).create(
      workspaceId,
      fields(request.body),
      requestActorId(request, request.body),
    );
    return reply.code(201).send({ entry });
  });

  app.patch<{ Params: EntryParams }>("/api/workspaces/:id/vault/:entryId", async (request) => {
    const workspaceId = workspace(request.params.id);
    return {
      entry: vaultStore(ctx).patch(
        workspaceId,
        request.params.entryId,
        fields(request.body),
        requestActorId(request, request.body),
      ),
    };
  });

  app.put<{ Params: EntryParams }>("/api/workspaces/:id/vault/:entryId/value", async (request) => {
    const workspaceId = workspace(request.params.id);
    return {
      entry: vaultStore(ctx).replaceValue(
        workspaceId,
        request.params.entryId,
        fields(request.body),
        requestActorId(request, request.body),
      ),
    };
  });

  app.put<{ Params: EntryParams }>(
    "/api/workspaces/:id/vault/:entryId/requests",
    async (request) => {
      const workspaceId = workspace(request.params.id);
      return {
        entry: vaultStore(ctx).setRequests(
          workspaceId,
          request.params.entryId,
          fields(request.body),
          requestActorId(request, request.body),
        ),
      };
    },
  );

  app.delete<{ Params: EntryParams; Querystring: { expectedRevision?: string } }>(
    "/api/workspaces/:id/vault/:entryId",
    async (request) => {
      const workspaceId = workspace(request.params.id);
      const revision = Number(request.query.expectedRevision);
      vaultStore(ctx).delete(
        workspaceId,
        request.params.entryId,
        Number.isSafeInteger(revision) ? revision : undefined,
        requestActorId(request, undefined),
      );
      return { deleted: request.params.entryId };
    },
  );
}

type RunParams = { Params: { runId: string } };
type RunEntryParams = { Params: { runId: string; entryId: string } };

function useRequest(body: Record<string, unknown>): VaultUseRequest {
  const { entryId, revision, approvalId, toolUseId } = body;
  if (
    typeof entryId !== "string" ||
    !Number.isSafeInteger(revision) ||
    typeof approvalId !== "string" ||
    typeof toolUseId !== "string" ||
    approvalId === "" ||
    toolUseId === ""
  )
    throw new DeskmatesError(
      "validation",
      "entryId, revision, approvalId and toolUseId are required",
    );
  return { entryId, revision: revision as number, approvalId, toolUseId };
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new DeskmatesError("validation", `${key} must be text of at most ${max} characters`, {
      field: key,
    });
  return value;
}

/** Run-token routes; registered inside the scope that verifies the token names this run. */
export function registerVaultInternalRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const run = (id: string) => ctx.runs.mustGet(id as RunId);
  /** A release is for a run that is executing now, never one that ended or is parked. */
  const live = (id: string) => {
    const record = run(id);
    if (!isExecuting(record.status))
      throw new DeskmatesError("invalid_transition", "the run is not executing", {
        status: record.status,
      });
    return record;
  };

  app.get<RunParams>("/internal/runs/:runId/vault/entries", async (request) =>
    vaultUses(ctx).list(run(request.params.runId)),
  );

  app.get<RunEntryParams>("/internal/runs/:runId/vault/entries/:entryId", async (request) => ({
    entry: vaultUses(ctx).facts(run(request.params.runId), request.params.entryId),
  }));

  app.post<RunParams>("/internal/runs/:runId/vault/fill", async (request) => {
    const body = asRecord(request.body);
    const tabId = optionalText(body, "tabId", 200);
    if (tabId === undefined)
      throw new DeskmatesError("validation", "tabId is required: the run's own browser tab");
    const frameUrl = optionalText(body, "frameUrl", 2000);
    const usernameField = optionalText(body, "usernameField", 300);
    const passwordField = optionalText(body, "passwordField", 300);
    const req: VaultFillUseRequest = {
      ...useRequest(body),
      tabId,
      ...(frameUrl ? { frameUrl } : {}),
      ...(usernameField ? { usernameField } : {}),
      ...(passwordField ? { passwordField } : {}),
    };
    return vaultUses(ctx).fill(live(request.params.runId), req);
  });

  app.post<RunParams>("/internal/runs/:runId/vault/request", async (request) => {
    const body = asRecord(request.body);
    const requestId = optionalText(body, "requestId", 100);
    if (requestId === undefined) throw new DeskmatesError("validation", "requestId is required");
    const params = body.params ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params))
      throw new DeskmatesError("validation", "params must be an object");
    const req: VaultRequestUseRequest = {
      ...useRequest(body),
      requestId,
      params: params as Record<string, string | number | boolean>,
    };
    return vaultUses(ctx).request(live(request.params.runId), req);
  });
}
