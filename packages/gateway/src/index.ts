// @deskmates/gateway entry point. Production has two Fastify listeners over one shared context:
// the sandbox-facing model/sidecar surface and the authenticated operator surface (ADR-0006).

import { existsSync } from "node:fs";
import {
  type ChannelPlugin,
  DOCKER_HOST_ALIAS,
  DeskmatesError,
  type SandboxProvider,
} from "@deskmates/contracts";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import {
  type RouteOptions,
  registerOperatorRoutes,
  registerRoutes,
  registerSandboxRoutes,
} from "./api/routes.js";
import { registerStaticUi, resolveWebDistDir } from "./api/static-ui.js";
import { createAppIngress } from "./app-shares/app-share-ingress.js";
import { PausedCronNotices } from "./bots/paused-cron-notices.js";
import { loadReleaseChannelPlugins } from "./channels/plugin-loader.js";
import { type GatewayConfig, loadConfig } from "./config.js";
import { type GatewayContext, buildContext } from "./context.js";
import { openDatabase } from "./db/open.js";
import { invokedDirectly } from "./invoked-directly.js";
import { reportNetworkOverlaps } from "./network/network-overlaps.js";
import { resolveProvider } from "./provider.js";
import { RunLifecycle } from "./scheduler/run-lifecycle.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { TaskDispatcher, TaskScheduleRunner } from "./tasks/task-dispatch.js";
import { TENANCY_MODE_DEFAULT, assertTenancyReady } from "./tenancy/tenancy-mode.js";
import { CronRunner } from "./triggers/cron.js";

export type { GatewayConfig } from "./config.js";
export { GROUP_ROUTING_DEFAULT, loadConfig } from "./config.js";
export type { GatewayContext } from "./context.js";
export { SIDECAR_RUN_CMD } from "./scheduler/scheduler.js";

export interface GatewayServices {
  ctx: GatewayContext;
  scheduler: Scheduler;
  lifecycle: RunLifecycle;
  cron: CronRunner;
  /** Per-task schedules (ADR-0021 A3d); started and stopped with the bot cron runner. */
  taskSchedules: TaskScheduleRunner;
}

declare module "fastify" {
  interface FastifyInstance {
    deskmates: GatewayServices;
  }
}

export interface BuildOptions extends RouteOptions {
  logger?: boolean;
  /** Combined routing is an explicit in-process test fixture and is never used by main(). */
  surface?: "sandbox" | "combined-test";
  /** Whether the cron runner's minute timer starts with the server; tests drive `tick` instead. */
  startCron?: boolean;
  /** How the connector proxy reaches connectors; T1 tests pass the testkit fake connector. */
  connectorFetch?: typeof fetch;
  /** Resolver for public connector hosts (ADR-0022 INT-02); tests pin answers. */
  connectorLookup?: (hostname: string) => Promise<string[]>;
  /** How the Gateway reaches the integration runtime; T1 tests pass the testkit fake runtime. */
  integrationFetch?: typeof fetch;
  /** Deterministic T1 injection; production loads only the release manifest. */
  channelPlugins?: Map<string, ChannelPlugin>;
}

const UNSPECIFIED_ADDRESSES = new Set(["0.0.0.0", "::", ""]);

/**
 * The host a sandbox should dial for a Gateway listening on `address`. An unspecified address
 * (`0.0.0.0`, `::`) is what `main()` binds and what a container cannot dial back, so it becomes
 * the Docker host alias for the Docker provider and loopback for in-process providers; a
 * concrete address is used as-is. `GATEWAY_BASE_URL` overrides all of this.
 */
export function sandboxReachableHost(
  address: string,
  providerKind: SandboxProvider["kind"],
): string {
  if (UNSPECIFIED_ADDRESSES.has(address)) {
    return providerKind === "docker" ? DOCKER_HOST_ALIAS : "127.0.0.1";
  }
  return address.includes(":") ? `[${address}]` : address;
}

export function buildGateway(
  config: GatewayConfig,
  provider: SandboxProvider,
  opts: BuildOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
  const db = openDatabase(config.dbPath);
  const gatewayBaseUrl = (): string => {
    if (config.gatewayBaseUrl) return config.gatewayBaseUrl;
    const addr = app.server.address();
    const port = addr && typeof addr === "object" ? addr.port : config.port;
    const address = addr && typeof addr === "object" ? addr.address : "127.0.0.1";
    return `http://${sandboxReachableHost(address, provider.kind)}:${port}`;
  };
  const ctx = buildContext(
    config,
    db,
    provider,
    gatewayBaseUrl,
    (msg, data) => app.log.info(data, msg),
    {
      ...(opts.connectorFetch ? { connectorFetch: opts.connectorFetch } : {}),
      ...(opts.connectorLookup ? { connectorLookup: opts.connectorLookup } : {}),
      ...(opts.integrationFetch ? { integrationFetch: opts.integrationFetch } : {}),
    },
  );
  // The second-tenant gate runs before anything is served (ADR-0022 decision 6).
  assertTenancyReady(db, config.tenancy ?? TENANCY_MODE_DEFAULT, ctx.auth.config);
  // The price table is loaded before any route can read it, so the first run of a fresh
  // deployment is priced like every later one (AGENTS.md: "The Gateway prices tokens").
  for (const price of config.modelPrices) ctx.prices.upsert(price);
  // ADR-0023 (test plan FB-04): a fallback the Gateway cannot price would turn every overload
  // into `pricing_missing`; refuse to start instead.
  if (
    config.fallbackModel !== undefined &&
    ctx.prices.listForModel(config.fallbackModel).length === 0
  ) {
    throw new DeskmatesError(
      "validation",
      `FALLBACK_MODEL "${config.fallbackModel}" has no price row; add it to MODEL_PRICES or the price table`,
      { key: "FALLBACK_MODEL" },
    );
  }
  const lifecycle = new RunLifecycle(ctx);
  const scheduler = new Scheduler(ctx, lifecycle, (msg, data) => app.log.warn(data ?? {}, msg));
  ctx.channels.setKick(() => scheduler.kick());
  const pausedCron = new PausedCronNotices(ctx);
  const cron = new CronRunner({
    bots: ctx.bots,
    runs: ctx.runs,
    events: ctx.events,
    runConfig: ctx.runConfig,
    timeZone: config.cronTimeZone,
    kick: () => scheduler.kick(),
    bus: ctx.bus,
    log: (msg, data) => app.log.info(data ?? {}, msg),
    onPausedSkip: (bot, entry, schedule) => pausedCron.skipped(bot, entry, schedule),
  });
  const taskSchedules = new TaskScheduleRunner(
    new TaskDispatcher(ctx, () => scheduler.kick()),
    undefined,
    (msg, data) => app.log.info(data ?? {}, msg),
  );
  app.decorate("deskmates", { ctx, scheduler, lifecycle, cron, taskSchedules });
  if (opts.surface === "combined-test") registerRoutes(app, ctx, lifecycle, scheduler, opts);
  else registerSandboxRoutes(app, ctx, lifecycle, scheduler, opts);
  app.addHook("onReady", async () => {
    if (opts.channelPlugins) {
      await ctx.channels.initialize(opts.channelPlugins);
    } else if (config.channelPluginManifest) {
      const loaded = await loadReleaseChannelPlugins(config.channelPluginManifest);
      await ctx.channels.initialize(loaded.plugins, loaded.failures);
    } else {
      await ctx.channels.initialize(new Map());
    }
    // ADR-0024 amendment 1: databases from before immediate private-chat creation have no
    // unopened Bot state after this Gateway starts. This does not enqueue retroactive greetings.
    ctx.privateChats.ensureExisting();
    scheduler.reconcile();
    scheduler.kick();
    if (opts.startCron !== false) {
      cron.start();
      taskSchedules.start();
      // ADR-0041 decision 4: the backfill, then a pass every interval; absent when unconfigured.
      ctx.retrieval.indexer?.start();
    }
  });
  app.addHook("onClose", async () => {
    await ctx.channels.stop();
    cron.stop();
    taskSchedules.stop();
    scheduler.stop();
    await ctx.retrieval.indexer?.stop();
    db.close();
  });
  return app;
}

export type OperatorBuildOptions = RouteOptions & { logger?: boolean };

/** Build the operator listener around services owned by `buildGateway`; no state is duplicated. */
export function buildOperatorGateway(
  services: GatewayServices,
  opts: OperatorBuildOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    forceCloseConnections: true,
    // EventSource has to put its credential in the URL. Do not let the framework's automatic
    // request log copy that URL into deployment logs.
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.decorate("deskmates", services);
  registerOperatorRoutes(app, services.ctx, services.scheduler, opts);
  // The built UI lives on this listener only (ADR-0006 decision 2); buildGateway never adds it.
  const webDistDir = services.ctx.config.webDistDir;
  if (webDistDir !== undefined) registerStaticUi(app, resolveWebDistDir(webDistDir));
  return app;
}

export async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig(process.env);
  const provider = await resolveProvider(config);
  const app = buildGateway(config, provider, { logger: true });
  const operatorApp = buildOperatorGateway(app.deskmates, { logger: true });
  if (app.deskmates.ctx.auth.config.cookieMode === "insecure-dev") {
    operatorApp.log.warn(
      "GATEWAY_SESSION_COOKIE=insecure-dev: session cookies are sent without Secure over plain HTTP; development only",
    );
  }
  // An empty database gets the protected root account (ADR-0031 decision 8). Its default
  // password can do nothing but be changed, at its first sign-in.
  if (await app.deskmates.ctx.auth.ensureProtectedRoot()) {
    operatorApp.log.warn(
      'Created the protected root account: sign in as "admin" with password "admin" and change it before anything else.',
    );
  }
  await app.listen({ port: config.port, host: config.bind });
  try {
    await operatorApp.listen({ port: config.operatorPort, host: config.operatorBind });
  } catch (err) {
    await app.close();
    throw err;
  }
  // ADR-0035 decision 2: published workspace apps on a listener of their own, when configured.
  const appIngress = config.appShares ? createAppIngress(app.deskmates.ctx) : undefined;
  if (appIngress && config.appShares) {
    const { port, bind } = config.appShares;
    await new Promise<void>((resolve, reject) => {
      appIngress.server.once("error", reject);
      appIngress.server.listen(port, bind, () => resolve());
    }).catch(async (err) => {
      await Promise.allSettled([operatorApp.close(), app.close()]);
      throw err;
    });
  }
  // ADR-0027 amendment 2 decision 15: warn about LAN targets inside a Docker network.
  void reportNetworkOverlaps(app.deskmates.ctx, (message) => operatorApp.log.warn(message));
  // ADR-0023 amendment 1, decision 6: models in use without a result for this configuration.
  if (config.visionProbe === "auto" && app.deskmates.ctx.modelJobs.vision.sweep().length > 0)
    app.deskmates.scheduler.kick();
  const shutdown = (): void => {
    Promise.allSettled([appIngress?.close(), operatorApp.close(), app.close()]).finally(() =>
      process.exit(0),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
