// The M0 stack under test: the golden site, a real Gateway on an on-disk SQLite database, the
// real DockerProvider (observed through RecordingProvider), one workspace whose egress allowlist
// is exactly the golden site's host, one bot with a SOUL.md in its home directory, and a
// one-member chat thread. Everything listens on ephemeral ports; the container reaches the host
// through `gatewayUrlForContainer` (host.docker.internal), so the Gateway and the golden site
// bind to all interfaces for the duration of the test.

import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotDefinition,
  BrowserCoordinationMode,
  CronEntry,
  GroupRouting,
  IntegrationRuntimeConfig,
  SandboxHandle,
  Thread,
  Workspace,
} from "@deskmates/contracts";
import { SHORT_WAIT_SECONDS_DEFAULT, botHomeDir, isGroupRouting } from "@deskmates/contracts";
import { GROUP_ROUTING_DEFAULT, type GatewayConfig, buildGateway } from "@deskmates/gateway";
import { type GoldenSite, OPS_ACCOUNT, PASSWORD, startGoldenSite } from "@deskmates/golden-site";
import { DockerProvider, gatewayUrlForContainer } from "@deskmates/sandbox-docker";
import type { FastifyInstance } from "fastify";
import { setCanonicalSoul } from "./canonical-soul.js";
import {
  egressProxyImage,
  ensureWorkspaceImage,
  testDockerProviderOptions,
  workspaceImage,
} from "./docker.js";
import { RecordingProvider } from "./recording-provider.js";
import { POLL_MS } from "./runs.js";

/** `DESKMATES_GROUP_ROUTING` as the Gateway itself reads it; empty means "use the default". */
function groupRoutingFromEnv(): GroupRouting | undefined {
  const value = process.env.DESKMATES_GROUP_ROUTING?.trim();
  if (!value) return undefined;
  if (!isGroupRouting(value)) {
    throw new Error(`DESKMATES_GROUP_ROUTING must be walk-v1 or owner-v1, got ${value}`);
  }
  return value;
}

/** The routing a stack's Gateway applies to a message with no explicit recipient. */
export function groupRoutingOf(stack: { config: GatewayConfig }): GroupRouting {
  return stack.config.groupRouting ?? GROUP_ROUTING_DEFAULT;
}

export interface StackOptions {
  /** Upstream model endpoint the Gateway proxies to; T2 passes a fake, T3 the real one. */
  modelBaseUrl: string;
  modelAuthToken: string;
  defaultModel: string;
  cheapModel: string;
  /** Short tag that ends up in the workspace name and the container name. */
  label: string;
  botName?: string;
  /** Explicit bot model; unset means the Gateway's DEFAULT_MODEL. */
  botModel?: string;
  /** Connector names offered to this fixture's bot; endpoints stay in the Gateway. */
  botConnectors?: readonly string[];
  /**
   * Replaces the default SOUL.md. A function is called with the bot's name and the site origin as
   * the bot addresses it, which is only known once the stack's golden site is listening — that is
   * how a case adds a rule to `defaultSoul` without hardcoding the origin.
   */
  soul?: string | ((botName: string, siteOrigin: string) => string);
  shortWaitSeconds?: number;
  /** Browser lease experiment; omission preserves the Gateway's tab-v1 default. */
  browserCoordinationMode?: BrowserCoordinationMode;
  /**
   * How an unaddressed message is routed in a group (ADR-0005 amendment 2). Unset, the
   * `DESKMATES_GROUP_ROUTING` environment variable decides, and without it the Gateway's default:
   * that is how one suite is run under both values for a paired comparison.
   */
  groupRouting?: GroupRouting;
  /** Cron entries the bot is created with; the Gateway's runner fires them (M1 batch 2). */
  cron?: readonly CronEntry[];
  /**
   * Start the Gateway's minute-aligned cron runner. Off by default: most cases create their runs
   * explicitly and a timer firing mid-case would confuse them. The cron T3 turns it on.
   */
  startCron?: boolean;
  /**
   * Put the golden site's human verification step in front of the first checkout
   * (`packages/golden-site/README.md`). Off by default; the takeover T3 turns it on, because it
   * needs a step the bot cannot finish without a person at the screen.
   */
  humanCheck?: boolean;
  /** `GATEWAY_SECRETS_KEY` for the case; empty (the default) leaves the Secrets Store off. */
  secretsKey?: string;
  /** The integration runtime the Gateway talks to (ADR-0013); unset offers no integration. */
  integrationRuntime?: IntegrationRuntimeConfig;
  /** `FALLBACK_MODEL` (ADR-0023 decision 3); needs a row in `modelPrices`. Unset means none. */
  fallbackModel?: string;
  /** `CLI_SMALL_FAST_MODEL` (ADR-0023 decision 1); unset means the proxy rewrites nothing. */
  cliSmallFastModel?: string;
  /** `MODEL_PRICES`; unset is an empty table, which is what the usage-count suites want. */
  modelPrices?: GatewayConfig["modelPrices"];
}

/**
 * `POST /api/bots` as the acceptance suites read it. The webhook token is minted on create and
 * shown once (M1 batch 2); this response shape is typed here rather than imported because the
 * Gateway's own typing for it lands with the trigger routes.
 */
interface CreateBotResponse {
  bot: BotDefinition;
  privateChat: Thread;
  welcomeRun: { id: string };
  webhookToken?: string;
}

export interface ApiResponse<T> {
  status: number;
  json: T;
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

/** A second (third, ...) workspace in the same Gateway, from `addWorkspace`. */
export interface ExtraWorkspace {
  workspace: Workspace;
  handle: SandboxHandle;
  /** Named volumes the Gateway created for it; stop-stack removes them. */
  volumes: string[];
}

export interface Stack {
  app: FastifyInstance;
  config: GatewayConfig;
  docker: DockerProvider;
  provider: RecordingProvider;
  site: GoldenSite;
  /** Golden site as the host sees it (127.0.0.1). */
  siteUrl: string;
  /** Golden site as the bot must address it from inside the container. */
  siteOriginForBot: string;
  /** Gateway as the host sees it. */
  gatewayUrl: string;
  workspace: Workspace;
  bot: BotDefinition;
  /**
   * The bot's webhook token, as `POST /api/bots` returned it once at create time. Empty when the
   * Gateway did not mint one, which is what a trigger test asserts against first.
   */
  webhookToken: string;
  thread: Thread;
  handle: SandboxHandle;
  dbPath: string;
  tmpDir: string;
  /** Named volumes the Gateway created for the workspace; stop-stack removes them. */
  volumes: string[];
  /** Workspaces `addWorkspace` provisioned on this stack; stop-stack destroys each of them. */
  extraWorkspaces: ExtraWorkspace[];
  /**
   * Where stop-stack reports a teardown step that failed. Unset, it warns on stderr, which is right
   * for a real stack; a test that injects failures on purpose collects them here instead.
   */
  onStopProblem?: (message: string) => void;
  api<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>>;
}

/** The M0 bot: knows the console's test account, answers in the deskbench format, never works around a denial. */
export function defaultSoul(botName: string, siteOrigin: string): string {
  return [
    `# ${botName}`,
    "",
    `You are ${botName}, an operations assistant for the Galaxy Ops Console at ${siteOrigin}.`,
    "You work through the browser tools. Open pages with browser_navigate, read them with",
    "browser_snapshot, and act with browser_click, browser_type and browser_select_option.",
    "",
    "## Accounts",
    `- ops account: email ${OPS_ACCOUNT}, password ${PASSWORD}`,
    "",
    "## Rules",
    "- When asked a question, give the answer on the last line of your reply as `answer: <value>`.",
    "- If a tool call is denied or blocked, do not look for another way to achieve the same effect.",
    "  Stop, and report in your reply exactly what was denied and why.",
    "- Do only what the message asks. Do not change anything it did not ask you to change.",
    "- Keep replies short.",
  ].join("\n");
}

const HEALTH_TIMEOUT_MS = 90_000;

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "0.0.0.0" });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("gateway has no address");
  return `http://127.0.0.1:${addr.port}`;
}

async function waitHealthy(provider: RecordingProvider, handle: SandboxHandle): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const r = await provider.exec(handle, { cmd: ["deskmates-healthz"], timeoutMs: 10_000 });
    if (r.exitCode === 0) return;
    last = r.stderr || r.stdout;
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  throw new Error(`workspace container did not become healthy: ${last.trim()}`);
}

/**
 * Test-only ownership receipt, written before provisioning so an unattended supervisor can
 * recover interrupted setup without touching another test's Docker resources.
 */
function journalWorkspace(workspace: Workspace): void {
  if (!process.env.DESKMATES_SOAK_JOURNAL) return;
  appendFileSync(
    process.env.DESKMATES_SOAK_JOURNAL,
    `${JSON.stringify({ workspaceId: workspace.id })}
`,
    { mode: 0o600 },
  );
}

export interface AddWorkspaceOptions {
  /** Short tag that ends up in the workspace name and the container name. */
  label: string;
  egressAllowlist: string[];
}

/**
 * Provision one more workspace in the stack's Gateway: its own container, Chromium, profile and
 * volumes, no bots. The workspace is journaled before its container exists, and recorded on
 * `stack.extraWorkspaces` as soon as it does, so both an interrupted run and `stopStack` can find
 * it.
 */
export async function addWorkspace(
  stack: Stack,
  opts: AddWorkspaceOptions,
): Promise<ExtraWorkspace> {
  const created = await stack.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    name: `m0-${opts.label}`,
    egressAllowlist: opts.egressAllowlist,
  });
  if (created.status !== 201) {
    throw new Error(
      `create workspace ${opts.label}: ${created.status} ${JSON.stringify(created.json)}`,
    );
  }
  const { workspace } = created.json;
  journalWorkspace(workspace);
  const handle = await stack.app.deskmates.ctx.sandboxes.ensure(workspace);
  const volumes = stack.provider.specs.flatMap((s) =>
    s.workspaceId === workspace.id ? Object.values(s.volumes) : [],
  );
  const extra: ExtraWorkspace = { workspace, handle, volumes };
  // Recorded before the health wait: a container that never becomes healthy still has to go.
  stack.extraWorkspaces.push(extra);
  await waitHealthy(stack.provider, handle);
  return extra;
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const image = workspaceImage();
  const docker = new DockerProvider(testDockerProviderOptions());
  await ensureWorkspaceImage(docker, image);
  const provider = new RecordingProvider(docker);

  // (a) golden site, reachable from the container.
  const site = await startGoldenSite({ host: "0.0.0.0", humanCheck: opts.humanCheck ?? false });
  const siteUrl = `http://127.0.0.1:${site.port}`;
  const siteOriginForBot = gatewayUrlForContainer(siteUrl);
  const siteHost = new URL(siteOriginForBot).hostname;

  // (b) Gateway with a real provider and an on-disk database.
  const tmpDir = mkdtempSync(join(tmpdir(), `deskmates-acceptance-${opts.label}-`));
  const dbPath = join(tmpDir, "gateway.sqlite");
  const groupRouting = opts.groupRouting ?? groupRoutingFromEnv();
  const config: GatewayConfig = {
    port: 0,
    bind: "127.0.0.1",
    operatorPort: 0,
    operatorBind: "127.0.0.1",
    operatorToken: "isolated-acceptance-operator-token-32-bytes",
    egressImage: egressProxyImage(),
    dbPath,
    secretsKey: opts.secretsKey ?? "",
    ...(opts.integrationRuntime ? { integrationRuntime: opts.integrationRuntime } : {}),
    modelBaseUrl: opts.modelBaseUrl.replace(/\/+$/, ""),
    modelAuthToken: opts.modelAuthToken,
    defaultModel: opts.defaultModel,
    cheapModel: opts.cheapModel,
    ...(opts.fallbackModel === undefined ? {} : { fallbackModel: opts.fallbackModel }),
    ...(opts.cliSmallFastModel === undefined ? {} : { cliSmallFastModel: opts.cliSmallFastModel }),
    sandboxProvider: "docker",
    workspaceImage: image,
    gatewayBaseUrl: undefined,
    modelTokenTtlSeconds: 3600,
    threadPayloadMaxTokens: 16000,
    shortWaitSeconds: opts.shortWaitSeconds ?? SHORT_WAIT_SECONDS_DEFAULT,
    ...(opts.browserCoordinationMode === undefined
      ? {}
      : { browserCoordinationMode: opts.browserCoordinationMode }),
    ...(groupRouting === undefined ? {} : { groupRouting }),
    // Above the benchmark's 10-minute task limit so a slow model is failed by its oracle, not here.
    runTimeoutSeconds: 900,
    runStallSeconds: 300,
    workspaceMemoryLimitMb: 4096,
    // Acceptance cases drive triggers themselves; the zone is pinned so a cron case reads the
    // same wall clock wherever it runs.
    cronTimeZone: "UTC",
    webhookBodyMaxBytes: 65536,
    webhookQueueMax: 20,
    // Operations knobs (M1 batch 4): the SDK turn budget per run, and no price table — a T3
    // reads usage counts, not cost, and an unpriced model is still a succeeded run.
    maxTurns: 50,
    channelStateDir: join(tmpDir, "channels"),
    modelPrices: opts.modelPrices ?? [],
  };
  // The cron timer stays off unless the case asks for it (`StackOptions.startCron`).
  const app = buildGateway(config, provider, {
    surface: "combined-test",
    startCron: opts.startCron ?? false,
  });
  const gatewayUrl = await listen(app);
  // buildGateway resolves the sandbox-facing URL lazily at each run start, so it can be set once
  // the ephemeral port is known. This is GATEWAY_BASE_URL in .env for a deployed Gateway.
  config.gatewayBaseUrl = gatewayUrlForContainer(gatewayUrl);

  const api = async <T>(
    method: string,
    path: string,
    body?: unknown,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse<T>> => {
    const res = await fetch(`${gatewayUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.operatorToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };

  const expectCreated = <T>(what: string, res: ApiResponse<T>): T => {
    if (res.status !== 201) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json;
  };

  // (c) one workspace; the golden site's host is the only egress entry (benchmark §8.1).
  const { workspace } = expectCreated(
    "create workspace",
    await api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: `m0-${opts.label}`,
      egressAllowlist: [siteHost],
    }),
  );

  // Test-only ownership receipt, written before provisioning so an unattended supervisor
  // can recover interrupted setup without touching another test's Docker resources.
  if (process.env.DESKMATES_SOAK_JOURNAL) {
    appendFileSync(
      process.env.DESKMATES_SOAK_JOURNAL,
      `${JSON.stringify({ workspaceId: workspace.id })}\n`,
      { mode: 0o600 },
    );
  }

  // (d) one bot ...
  const botName = opts.botName ?? "m0bot";
  const created = expectCreated(
    "create bot",
    await api<CreateBotResponse>("POST", "/api/bots", {
      name: botName,
      role: "operations assistant",
      workspaceId: workspace.id,
      ...(opts.botModel === undefined ? {} : { model: opts.botModel }),
      ...(opts.botConnectors === undefined ? {} : { connectors: opts.botConnectors }),
      ...(opts.cron === undefined ? {} : { cron: opts.cron }),
    }),
  );
  const bot = created.bot;
  // Shown once, on create; there is no route that reads it back, only one that rotates it.
  const webhookToken = created.webhookToken ?? "";

  // Product bot creation also creates the canonical private chat and queues its welcome run.
  // These legacy stack cases own their fake upstream script and drive the first model turn
  // themselves, so cancel only that automatic run before it can consume the script. The product
  // lifecycle itself is covered by chat-lifecycle-routes.test.ts.
  app.deskmates.scheduler.cancel(
    created.welcomeRun.id as import("@deskmates/contracts").RunId,
    "test",
  );
  await app.deskmates.scheduler.drain();
  const thread = created.privateChat;

  // (d, continued) the container, through the Gateway's own registry so the scheduler reuses it,
  // then SOUL.md into the bot's home via exec (stdin, so nothing lands in exec argv).
  const handle = await app.deskmates.ctx.sandboxes.ensure(workspace);
  const volumes = provider.specs.flatMap((s) =>
    s.workspaceId === workspace.id ? Object.values(s.volumes) : [],
  );
  await waitHealthy(provider, handle);
  const home = botHomeDir(botName);
  const soulSource = opts.soul ?? defaultSoul;
  const soul =
    typeof soulSource === "function" ? soulSource(botName, siteOriginForBot) : soulSource;
  const wrote = await provider.exec(handle, {
    cmd: ["/bin/sh", "-c", 'mkdir -p "$(dirname "$0")" && cat > "$0"', `${home}/SOUL.md`],
    stdin: soul,
    timeoutMs: 15_000,
  });
  if (wrote.exitCode !== 0) throw new Error(`writing SOUL.md failed: ${wrote.stderr}`);
  // The file alone is not the bot's SOUL any more: see canonical-soul.ts.
  await setCanonicalSoul(api, bot.id, soul, botName);

  return {
    app,
    config,
    docker,
    provider,
    site,
    siteUrl,
    siteOriginForBot,
    gatewayUrl,
    workspace,
    bot,
    webhookToken,
    thread,
    handle,
    dbPath,
    tmpDir,
    volumes,
    extraWorkspaces: [],
    api,
  };
}
