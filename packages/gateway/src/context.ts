// The wired-up set of stores and services one Gateway process owns. Built once in `buildGateway`
// and handed to routes, the scheduler and the run lifecycle so nothing reaches for globals.
//
// A domain whose stores are built together has a `create...` function next to them (issue #53);
// `buildContext` stays the one explicit place that wires domains to each other. None of them
// owns a lifecycle: closers are registered by the routes and `buildGateway`.

import { dirname, join } from "node:path";
import type { SandboxProvider } from "@deskmates/contracts";
import { ApprovalStore } from "./approvals/approvals.js";
import { ApprovalReviews } from "./approvals/auto-review.js";
import { ApprovalBroker } from "./approvals/broker.js";
import { queueApprovalPresentation } from "./approvals/presentation.js";
import { ApprovalRuleStore } from "./approvals/rules.js";
import { AuditLog } from "./audit/audit-log.js";
import { AuthService } from "./auth/auth-service.js";
import { OidcService } from "./auth/oidc-service.js";
import { OidcStore } from "./auth/oidc-store.js";
import { BotStore } from "./bots/bots.js";
import { BudgetStore } from "./budget/budget-store.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { ChannelStore } from "./channels/channel-store.js";
import { GROUP_ROUTING_DEFAULT, type GatewayConfig } from "./config.js";
import { createConnectorModule } from "./connectors/connector-module.js";
import type { ConnectorProxy } from "./connectors/connector-proxy.js";
import type { ReceiptStore } from "./connectors/receipts.js";
import type { ConnectorRegistry } from "./connectors/registry.js";
import type { ValidationStore } from "./connectors/validations.js";
import type { GatewayDb } from "./db/open.js";
import { EventBus } from "./events/bus.js";
import { Presence } from "./events/presence.js";
import { createIntegrationService } from "./integrations/integration-module.js";
import type { IntegrationService } from "./integrations/integration-service.js";
import { KnowledgeStore } from "./knowledge/knowledge.js";
import { type ActivitySummaryStore, createActivitySummaries } from "./ledger/activity-summaries.js";
import { CostAlertStore } from "./ledger/cost-alerts.js";
import { CostQueryStore } from "./ledger/costs.js";
import { EventStore } from "./ledger/events.js";
import { ModelRequestStore } from "./ledger/model-requests.js";
import { PriceStore } from "./ledger/prices.js";
import { createRunConfig } from "./ledger/run-config.js";
import { RunStore } from "./ledger/runs.js";
import { UsageStore } from "./ledger/usage.js";
import { WorkspaceLimitStore } from "./limits/workspace-limits.js";
import { LearnedMemory } from "./memory/learned-memory.js";
import { ModelJobs } from "./model-jobs/model-jobs.js";
import { RunTokenStore } from "./secrets/run-tokens.js";
import { SecretsStore } from "./secrets/secrets-store.js";
import { SkillService } from "./skills/skill-service.js";
import { TaskStore } from "./tasks/tasks.js";
import type { Ownership } from "./tenancy/ownership.js";
import type { TenantQuotas } from "./tenancy/quotas.js";
import { createTenancyModule } from "./tenancy/tenancy-module.js";
import type { MessageStore } from "./threads/messages.js";
import type { PrivateChatStore } from "./threads/private-chats.js";
import { routePrivateMentions } from "./threads/private-mentions.js";
import type { RoundStore } from "./threads/rounds.js";
import { ThreadRouter } from "./threads/router.js";
import type { RoutingWalkStore } from "./threads/routing-walks.js";
import type { SessionStore } from "./threads/sessions.js";
import { createThreadModule } from "./threads/thread-module.js";
import type { ThreadPinStore } from "./threads/thread-pins.js";
import type { ThreadStore } from "./threads/threads.js";
import { BrowserLockStore } from "./workspaces/browser-lock.js";
import { BrowserOriginQueueStore } from "./workspaces/browser-origin-queue.js";
import { createSandboxRegistry } from "./workspaces/sandbox-module.js";
import type { SandboxRegistry } from "./workspaces/sandboxes.js";
import { ScreenSlotStore } from "./workspaces/screen-slots.js";
import { WorkspaceStore } from "./workspaces/workspaces.js";

export interface GatewayContext {
  config: GatewayConfig;
  /** Browser sign-in, persistent sessions and their live connections (ADR-0022 P1). */
  auth: AuthService;
  /** Generic OIDC sign-in, identity linking and tenant SSO step-up (ADR-0022 decision 3). */
  oidc: OidcService;
  /** Per-tenant queued-run and API request limits (ADR-0022 LIMIT-01). */
  quotas: TenantQuotas;
  /** Which tenant owns a row; the one place every tenant check resolves through (ADR-0022). */
  ownership: Ownership;
  knowledge: KnowledgeStore;
  /** Learned memory: entries, the confirmation queue and consolidation (ADR-0011). */
  memory: LearnedMemory;
  /** Skills per workspace: run skill sets, review, stages, measured use (ADR-0015). */
  skills: SkillService;
  db: GatewayDb;
  provider: SandboxProvider;
  bus: EventBus;
  workspaces: WorkspaceStore;
  bots: BotStore;
  threads: ThreadStore;
  privateChats: PrivateChatStore;
  /** Workspace-shared rail presentation; routing and scheduling never read it. */
  threadPins: ThreadPinStore;
  tasks: TaskStore;
  messages: MessageStore;
  sessions: SessionStore;
  router: ThreadRouter;
  walks: RoutingWalkStore;
  rounds: RoundStore;
  runs: RunStore;
  events: EventStore;
  /** One row per request the model proxy forwards (M3 context plan, Phase 1). */
  modelRequests: ModelRequestStore;
  /** ADR-0033: cached Activity summaries; queues a recorded job when a long run ends. */
  activitySummaries: ActivitySummaryStore;
  /** Vision probes and SOUL proposals: short model jobs (ADR-0023 amendment 1). */
  modelJobs: ModelJobs;
  approvals: ApprovalStore;
  rules: ApprovalRuleStore;
  /** Approval decisions and workspace configuration changes (ADR-0031 decision 11). */
  audit: AuditLog;
  broker: ApprovalBroker;
  /** Whether a human is watching, which decides live wait vs immediate defer (ADR-0002). */
  presence: Presence;
  prices: PriceStore;
  usage: UsageStore;
  /** Soft cost thresholds, evaluated when a run's usage lands (ADR-0018). */
  costAlerts: CostAlertStore;
  /** Workspace monetary budget: limits, charges, admission and parks (ADR-0032). */
  budget: BudgetStore;
  /** Workspace execution limits (ADR-0005 amendment 5, ADR-0016 amendment 2). */
  limits: WorkspaceLimitStore;
  tokens: RunTokenStore;
  locks: BrowserLockStore;
  originQueue: BrowserOriginQueueStore;
  sandboxes: SandboxRegistry;
  screens: ScreenSlotStore;
  /** Values the Gateway reads back, encrypted with `GATEWAY_SECRETS_KEY`. */
  secrets: SecretsStore;
  /** Connector registry, validations, receipts and the proxy, their only caller (ADR-0012). */
  connectors: ConnectorRegistry;
  connectorValidations: ValidationStore;
  connectorReceipts: ReceiptStore;
  connectorProxy: ConnectorProxy;
  /** Integration runtime access, the only path from a run to it (ADR-0013). */
  integrations: IntegrationService;
  /** Release-bundled channel plugins and their workspace-scoped connections (ADR-0017 A1). */
  channels: ChannelManager;
  /** URL sandboxes use to reach this Gateway; resolved after listen when not configured. */
  gatewayBaseUrl: () => string;
  /** The knob configuration stamped on every run row (AGENTS.md: `runs.config_json`). */
  runConfig: () => Record<string, unknown>;
}

export interface ContextOptions {
  /** How the connector proxy reaches connectors; tests pass the testkit fake connector's fetch. */
  connectorFetch?: typeof globalThis.fetch;
  /** How a public connector's hostname resolves; tests pin answers instead of using DNS. */
  connectorLookup?: (hostname: string) => Promise<string[]>;
  /** How the Gateway reaches the integration runtime; tests pass the testkit fake runtime's fetch. */
  integrationFetch?: typeof globalThis.fetch;
  /** Clock for validation TTLs and receipt versions; tests move it. */
  clock?: () => Date;
}

export function buildContext(
  config: GatewayConfig,
  db: GatewayDb,
  provider: SandboxProvider,
  gatewayBaseUrl: () => string,
  /** Operational log for lifecycle events outside a run, e.g. a stale sandbox recreated. */
  log: (msg: string, data: Record<string, unknown>) => void = () => {},
  opts: ContextOptions = {},
): GatewayContext {
  const bus = new EventBus();
  const events = new EventStore(db, (event, threadId) =>
    bus.publish(threadId ? { type: "run_event", threadId, event } : { type: "run_event", event }),
  );
  const prices = new PriceStore(db);
  const workspaces = new WorkspaceStore(db);
  const runs = new RunStore(db);
  const bots = new BotStore(db);
  const thread = createThreadModule(db, bus, bots);
  const { threads, messages, walks } = thread;
  const approvals = new ApprovalStore(db);
  const rules = new ApprovalRuleStore(db);
  const presence = new Presence();
  const secrets = new SecretsStore(db, config.secretsKey);
  const runConfig = createRunConfig(config);
  const budget = new BudgetStore(db, opts.clock);
  const limits = new WorkspaceLimitStore(db, budget, () => config.maxTurns);
  const router = new ThreadRouter(
    threads,
    messages,
    runs,
    runConfig,
    walks,
    events,
    (created) => {
      for (const run of created) {
        bus.publish(
          run.threadId
            ? { type: "run_status", threadId: run.threadId, run }
            : { type: "run_status", run },
        );
      }
    },
    (message) => bus.publish({ type: "thread_message", threadId: message.threadId, message }),
    {
      groupRouting: config.groupRouting ?? GROUP_ROUTING_DEFAULT,
      rounds: thread.rounds,
      limits,
      onThreadChanged: (threadId) => bus.publish({ type: "thread_members", threadId }),
      batch: (work) => bus.batch(work),
      onBotMessage: (run, message, blocked) => routePrivateMentions(context, run, message, blocked),
    },
  );
  // ADR-0015 decision 6: use is what the sidecar's hook recorded, read off the ledger as it lands.
  const skills = new SkillService({
    db,
    allowlistOf: (id) => workspaces.mustGet(id).egressAllowlist,
    botWorkspace: (id) => bots.get(id)?.workspaceId,
    runOf: (id) => {
      const run = runs.get(id);
      return run ? { botId: run.botId, config: run.config } : undefined;
    },
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  bus.subscribe((event) => {
    if (event.type === "run_event" && event.event.kind === "skill_used")
      skills.recordUse(event.event);
  });
  const auth = new AuthService(db, config.auth, opts.clock);
  const { ownership, quotas } = createTenancyModule(db, config, opts.clock);
  const broker = new ApprovalBroker({
    reviews: new ApprovalReviews({
      db,
      runs,
      messages,
      runConfig,
      model: () => config.defaultModel,
    }),
    queuePresentation: (approval) => {
      const queued = queueApprovalPresentation(approval, runs, runConfig(), config.defaultModel);
      if (queued) bus.publish({ type: "run_status", run: queued });
    },
    approvals,
    rules,
    runs,
    events,
    messages,
    threads,
    router,
    bots,
    bus,
    presence,
    runTenant: (runId) => ownership.tenantOf("run", runId),
    ownSecrets: config.modelAuthToken ? [config.modelAuthToken] : [],
  });
  const channels = new ChannelManager({
    store: new ChannelStore(db),
    secrets,
    workspaces,
    bots,
    threads,
    messages,
    router,
    approvals,
    broker,
    ownership,
    quotas,
    bus,
    stateRoot: config.channelStateDir,
    log: (level, message, data) => log(message, { level, ...(data ?? {}) }),
  });
  const context: GatewayContext = {
    config,
    auth,
    oidc: new OidcService(new OidcStore(db, secrets, opts.clock), auth, opts.clock),
    ownership,
    quotas,
    secrets,
    ...createConnectorModule({
      db,
      config,
      secrets,
      runs,
      bots,
      events,
      ...(opts.connectorFetch ? { fetch: opts.connectorFetch } : {}),
      ...(opts.connectorLookup ? { lookup: opts.connectorLookup } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    }),
    integrations: createIntegrationService({
      db,
      config,
      secrets,
      runs,
      bots,
      workspaces,
      events,
      ...(opts.integrationFetch ? { fetch: opts.integrationFetch } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    }),
    screens: new ScreenSlotStore(db),
    memory: new LearnedMemory({
      db,
      runs,
      bots,
      rules,
      workspaces,
      runConfig,
      cheapModel: () => config.cheapModel,
    }),
    skills,
    knowledge: new KnowledgeStore(
      db,
      config.dbPath === ":memory:" ? undefined : join(dirname(config.dbPath), "knowledge"),
    ),
    db,
    provider,
    bus,
    workspaces,
    bots,
    ...thread,
    tasks: new TaskStore(db, opts.clock, config.cronTimeZone),
    router,
    runs,
    events,
    modelRequests: new ModelRequestStore(db),
    activitySummaries: createActivitySummaries({
      db,
      bus,
      runs,
      runConfig,
      cheapModel: () => config.cheapModel,
      messageBody: (id) => messages.get(id)?.body,
    }),
    modelJobs: new ModelJobs(() => context),
    approvals,
    rules,
    audit: new AuditLog(db),
    broker,
    presence,
    prices,
    usage: new UsageStore(db, prices, events),
    costAlerts: new CostAlertStore(db, new CostQueryStore(db), events),
    budget,
    limits,
    tokens: new RunTokenStore(db, config.modelTokenTtlSeconds),
    locks: new BrowserLockStore(db),
    originQueue: new BrowserOriginQueueStore(db),
    sandboxes: createSandboxRegistry({ provider, config, workspaces, ownership, db, log }),
    gatewayBaseUrl,
    runConfig,
    channels,
  };
  return context;
}
