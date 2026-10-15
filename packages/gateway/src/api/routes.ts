// Route-family registration. Production puts the two families on different listeners; the
// combined helper exists only for the in-process T1 fixture.

import type { FastifyInstance } from "fastify";
import { registerAppShareRoutes } from "../app-shares/app-share-routes.js";
import { budgetAdmission } from "../budget/admission.js";
import type { GatewayContext } from "../context.js";
import { frozenModelsOf } from "../model-proxy/frozen-models.js";
import { registerModelProxy } from "../model-proxy/model-proxy.js";
import type { RunLifecycle } from "../scheduler/run-lifecycle.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { registerApprovalRoutes } from "./approval-routes.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBoardRoutes } from "./board-routes.js";
import { registerBudgetRoutes } from "./budget-routes.js";
import { registerCapacityRoutes } from "./capacity-routes.js";
import { registerChannelRoutes, registerChannelWebhookRoutes } from "./channel-routes.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerConnectorRoutes } from "./connector-routes.js";
import { registerCostAlertRoutes } from "./cost-alert-routes.js";
import { registerCostRoutes } from "./cost-routes.js";
import { registerErrorHandler } from "./errors.js";
import { registerEventsRoute } from "./events-route.js";
import { registerFileCollectionRoutes } from "./file-collection-routes.js";
import { registerFileRoutes } from "./file-routes.js";
import { registerFileUploadRoutes } from "./file-upload-routes.js";
import {
  registerIntegrationOAuthCallbackRoute,
  registerIntegrationRoutes,
} from "./integration-routes.js";
import { registerInternalRoutes } from "./internal-routes.js";
import { registerKnowledgeRoutes } from "./knowledge-routes.js";
import { registerLearnedMemoryRoutes } from "./learned-memory-routes.js";
import { registerLimitRoutes } from "./limit-routes.js";
import { registerMemberRoutes } from "./member-routes.js";
import { registerMemoryMaintenanceRoutes } from "./memory-maintenance-routes.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { registerMemorySuggestionRoutes } from "./memory-suggestion-routes.js";
import { registerModelJobRoutes } from "./model-job-routes.js";
import { registerNetworkRoutes } from "./network-routes.js";
import { registerOperatorAuth } from "./operator-auth.js";
import { registerPreferenceRoutes } from "./preference-routes.js";
import { registerPriceRoutes } from "./price-routes.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { registerRegistryRoutes } from "./registry-routes.js";
import { registerRoutePolicy } from "./route-policy.js";
import { registerRunCancelRoutes } from "./run-cancel-routes.js";
import { registerRunContextRoutes } from "./run-context-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerRunTimelineRoutes } from "./run-timeline-routes.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import { registerScreenRoutes } from "./screen-routes.js";
import { registerServicePrincipalRoutes } from "./service-principal-routes.js";
import { registerSkillRoutes } from "./skill-routes.js";
import { registerSubmitRoutes } from "./submit-routes.js";
import { registerTakeoverRoutes } from "./takeover-routes.js";
import { registerTaskRoutes } from "./task-routes.js";
import { registerThreadRoundRoutes } from "./thread-round-routes.js";
import { registerThreadRoutes } from "./thread-routes.js";
import { registerTrashRoutes } from "./trash-routes.js";
import { registerWebhookDeliveryRoute, registerWebhookTokenRoute } from "./webhook-routes.js";
import { registerWorkdirRoutes } from "./workdir-routes.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";

export interface RouteOptions {
  sseHeartbeatMs?: number;
  fetchImpl?: typeof fetch;
  /** Internal composition flag for the combined T1 listener. */
  skipErrorHandler?: boolean;
}

/** What an operator route family may use; each family takes only what it needs. */
export interface OperatorRouteDeps {
  ctx: GatewayContext;
  scheduler: Scheduler;
  opts: RouteOptions;
}

type RegisterFamily = (scope: FastifyInstance, deps: OperatorRouteDeps) => void;

/**
 * The route families behind the operator guard, by name, sorted (issue #53): a new domain adds
 * one line. `routes.test.ts` checks the order. Registration order does not matter here: the
 * guard hooks are installed before the list, and no family's routes depend on another's.
 */
export const OPERATOR_ROUTE_FAMILIES: ReadonlyArray<readonly [name: string, RegisterFamily]> = [
  ["app-shares", (scope, { ctx }) => registerAppShareRoutes(scope, ctx)],
  ["approvals", (scope, { ctx, scheduler }) => registerApprovalRoutes(scope, ctx, scheduler)],
  ["board", (scope, { ctx }) => registerBoardRoutes(scope, ctx)],
  ["budgets", (scope, { ctx, scheduler }) => registerBudgetRoutes(scope, ctx, scheduler)],
  ["capacity", (scope, { ctx, scheduler }) => registerCapacityRoutes(scope, ctx, scheduler)],
  ["channels", (scope, { ctx }) => registerChannelRoutes(scope, ctx)],
  ["config", (scope, { ctx }) => registerConfigRoutes(scope, ctx)],
  ["connectors", (scope, { ctx }) => registerConnectorRoutes(scope, ctx)],
  ["cost-alerts", (scope, { ctx }) => registerCostAlertRoutes(scope, ctx)],
  ["costs", (scope, { ctx }) => registerCostRoutes(scope, ctx)],
  ["events", (scope, { ctx, opts }) => registerEventsRoute(scope, ctx, opts.sseHeartbeatMs)],
  ["file-collection", (scope, { ctx }) => registerFileCollectionRoutes(scope, ctx)],
  ["file-uploads", (scope, { ctx }) => registerFileUploadRoutes(scope, ctx)],
  ["files", (scope, { ctx }) => registerFileRoutes(scope, ctx)],
  ["integrations", (scope, { ctx }) => registerIntegrationRoutes(scope, ctx)],
  ["knowledge", (scope, { ctx }) => registerKnowledgeRoutes(scope, ctx)],
  [
    "learned-memory",
    (scope, { ctx, scheduler }) => registerLearnedMemoryRoutes(scope, ctx, scheduler),
  ],
  ["limits", (scope, { ctx }) => registerLimitRoutes(scope, ctx)],
  ["members", (scope, { ctx }) => registerMemberRoutes(scope, ctx)],
  ["memory", (scope, { ctx, scheduler }) => registerMemoryRoutes(scope, ctx, scheduler)],
  [
    "memory-maintenance",
    (scope, { ctx, scheduler }) => registerMemoryMaintenanceRoutes(scope, ctx, scheduler),
  ],
  ["memory-suggestions", (scope, { ctx }) => registerMemorySuggestionRoutes(scope, ctx)],
  ["model-jobs", (scope, { ctx, scheduler }) => registerModelJobRoutes(scope, ctx, scheduler)],
  ["network", (scope, { ctx }) => registerNetworkRoutes(scope, ctx)],
  // `/auth/preferences` sits outside `/api` but needs this scope's session and CSRF checks.
  ["preferences", (scope, { ctx }) => registerPreferenceRoutes(scope, ctx)],
  ["prices", (scope, { ctx }) => registerPriceRoutes(scope, ctx)],
  // So do the person's own profile and avatar (ADR-0022 amendment 3).
  ["profile", (scope, { ctx }) => registerProfileRoutes(scope, ctx)],
  ["registry", (scope, { ctx, scheduler }) => registerRegistryRoutes(scope, ctx, scheduler)],
  ["run-cancel", (scope, { ctx, scheduler }) => registerRunCancelRoutes(scope, ctx, scheduler)],
  ["run-context", (scope, { ctx }) => registerRunContextRoutes(scope, ctx)],
  ["run-timeline", (scope, { ctx }) => registerRunTimelineRoutes(scope, ctx)],
  ["runs", (scope, { ctx }) => registerRunRoutes(scope, ctx)],
  ["runtime", (scope, { ctx }) => registerRuntimeRoutes(scope, ctx)],
  ["screens", (scope, { ctx }) => registerScreenRoutes(scope, ctx)],
  ["service-principals", (scope, { ctx }) => registerServicePrincipalRoutes(scope, ctx)],
  ["skills", (scope, { ctx }) => registerSkillRoutes(scope, ctx)],
  ["submit", (scope, { ctx, scheduler }) => registerSubmitRoutes(scope, ctx, scheduler)],
  ["takeover", (scope, { ctx }) => registerTakeoverRoutes(scope, ctx)],
  ["tasks", (scope, { ctx, scheduler }) => registerTaskRoutes(scope, ctx, scheduler)],
  [
    "thread-rounds",
    (scope, { ctx, scheduler }) => registerThreadRoundRoutes(scope, ctx, scheduler),
  ],
  ["threads", (scope, { ctx, scheduler }) => registerThreadRoutes(scope, ctx, scheduler)],
  ["trash", (scope, { ctx, scheduler }) => registerTrashRoutes(scope, ctx, scheduler)],
  ["webhook-token", (scope, { ctx }) => registerWebhookTokenRoute(scope, ctx)],
  ["workdir", (scope, { ctx }) => registerWorkdirRoutes(scope, ctx)],
  ["workspaces", (scope, { ctx, scheduler }) => registerWorkspaceRoutes(scope, ctx, scheduler)],
];

export function registerSandboxRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  lifecycle: RunLifecycle,
  scheduler: Scheduler,
  opts: RouteOptions = {},
): void {
  if (!opts.skipErrorHandler) registerErrorHandler(app);
  app.get("/healthz", async () => ({ ok: true }));
  registerInternalRoutes(app, ctx, lifecycle, scheduler);
  registerModelProxy(app, {
    tokens: ctx.tokens,
    upstreamBaseUrl: ctx.config.modelBaseUrl,
    upstreamToken: ctx.config.modelAuthToken,
    timingForRun: (runId) => {
      // Capture the attempt with the request. A parked run may resume while an old connection is
      // winding down; its timing still belongs to the process that opened it.
      const attempt = ctx.runs.mustGet(runId).attempt;
      return (sample) => {
        ctx.events.append({ runId, attempt, kind: "log", payload: { ...sample }, ts: sample.at });
      };
    },
    recordRequest: (runId, facts) => {
      // Same attempt capture as timing: the row belongs to the process that opened the request.
      const attempt = ctx.runs.mustGet(runId).attempt;
      const id = ctx.modelRequests.insert({
        runId,
        attempt,
        ts: new Date().toISOString(),
        ...facts,
      });
      return (usage) => {
        ctx.modelRequests.setUsage(id, usage);
        // ADR-0032 decision 3: a response's usage is charged to the budget as it lands.
        try {
          ctx.budget.charge(runId);
        } catch {
          // Accounting only; the model call already happened.
        }
      };
    },
    // ADR-0032 decisions 5 and 6: an exhausted workspace refuses the call and parks the run.
    admit: (runId) => budgetAdmission(ctx, runId),
    // ADR-0023 decision 1: the run row, frozen at start, is the only source of allowed models.
    frozenModels: (runId) => frozenModelsOf(ctx.runs.mustGet(runId).config),
    ...(ctx.config.cliSmallFastModel ? { smallFastModel: ctx.config.cliSmallFastModel } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

export function registerOperatorRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  scheduler: Scheduler,
  opts: RouteOptions = {},
): void {
  if (!opts.skipErrorHandler) registerErrorHandler(app);
  app.register(async (scope) => {
    registerOperatorAuth(scope, ctx);
    // Role and tenant ownership of every identifier, before any handler (ADR-0022 P2).
    registerRoutePolicy(scope, ctx);
    const deps: OperatorRouteDeps = { ctx, scheduler, opts };
    for (const [, register] of OPERATOR_ROUTE_FAMILIES) register(scope, deps);
  });
  // Sign-in, session and logout routes carry their own Origin and CSRF checks (ADR-0022 P1).
  registerAuthRoutes(app, ctx);
  app.addHook("onClose", async () => ctx.auth.live.stop());
  // Webhook delivery is external ingress with its own one-time per-bot path credential. It lives
  // on the operator listener so a sandbox cannot invoke it, but it is not an operator API route.
  registerWebhookDeliveryRoute(app, ctx, scheduler);
  // The OAuth provider redirects the operator's browser here with no Bearer header; the one-time
  // `state` of the grant is the credential (ADR-0013 item 4).
  registerIntegrationOAuthCallbackRoute(app, ctx);
  registerChannelWebhookRoutes(app, ctx);
}

/** Explicit combined listener for T1 tests. Production must use the split builders in index.ts. */
export function registerRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  lifecycle: RunLifecycle,
  scheduler: Scheduler,
  opts: RouteOptions = {},
): void {
  registerSandboxRoutes(app, ctx, lifecycle, scheduler, opts);
  registerOperatorRoutes(app, ctx, scheduler, { ...opts, skipErrorHandler: true });
}
