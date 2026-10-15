// T1 harness: a Gateway on an in-memory database listening on a random localhost port, the fake
// provider, and small helpers for the API, SSE and polling.

import type {
  ApprovalMode,
  BotDefinition,
  ChannelPlugin,
  Thread,
  Workspace,
} from "@deskmates/contracts";
import type { FastifyInstance } from "fastify";
import type { GatewayConfig } from "../config.js";
import type { GatewayEvent } from "../events/bus.js";
import { buildGateway } from "../index.js";
import { FakeProvider } from "./fake-provider.js";

export const TEST_UPSTREAM_TOKEN = "upstream-secret-token-do-not-store-9f8e7d";
export const TEST_OPERATOR_TOKEN = "operator-test-token-at-least-32-bytes-long";

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    bind: "127.0.0.1",
    operatorPort: 0,
    operatorBind: "127.0.0.1",
    operatorToken: TEST_OPERATOR_TOKEN,
    dbPath: ":memory:",
    secretsKey: "",
    modelBaseUrl: "http://127.0.0.1:1",
    modelAuthToken: TEST_UPSTREAM_TOKEN,
    defaultModel: "test-model-default",
    cheapModel: "test-model-cheap",
    sandboxProvider: "docker",
    workspaceImage: "deskmates/workspace:test",
    egressImage: "deskmates/egress-proxy:test",
    gatewayBaseUrl: undefined,
    modelTokenTtlSeconds: 600,
    threadPayloadMaxTokens: 16000,
    shortWaitSeconds: 1,
    runTimeoutSeconds: 30,
    runStallSeconds: 300,
    workspaceMemoryLimitMb: 4096,
    cronTimeZone: "UTC",
    webhookBodyMaxBytes: 65536,
    webhookQueueMax: 20,
    maxTurns: 50,
    channelStateDir: "./data/test-channels",
    modelPrices: [],
    // Bot creation would otherwise queue a probe run in every test; probe tests turn it on.
    visionProbe: "off",
    ...overrides,
  };
}

export interface Harness {
  app: FastifyInstance;
  provider: FakeProvider;
  baseUrl: string;
  api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
  /** A workspace, a bot and its thread; the workspace is in `manual` approval mode by default. */
  seed(options?: {
    approvalMode?: ApprovalMode;
  }): Promise<{ workspace: Workspace; bot: BotDefinition; thread: Thread }>;
  close(): Promise<void>;
}

export async function startHarness(
  overrides: Partial<GatewayConfig> = {},
  fetchImpl?: typeof fetch,
  extra: {
    connectorFetch?: typeof fetch;
    connectorLookup?: (hostname: string) => Promise<string[]>;
    integrationFetch?: typeof fetch;
    channelPlugins?: Map<string, ChannelPlugin>;
  } = {},
): Promise<Harness> {
  const provider = new FakeProvider();
  const app = buildGateway(testConfig(overrides), provider, {
    ...extra,
    surface: "combined-test",
    sseHeartbeatMs: 50,
    // Tests drive `app.deskmates.cron.tick(<minute>)` with an injected clock; a wall-clock timer
    // would fire runs in the middle of an unrelated case.
    startCron: false,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const api = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };

  const seed = async (options: { approvalMode?: ApprovalMode } = {}) => {
    const ws = await api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ws-1",
      egressAllowlist: ["*.example.test"],
    });
    // A new workspace starts in automatic review (ADR-0002 amendment 6, D1); most tests pin the
    // human approval path, so the fixture is `manual` unless a test asks for another mode. The
    // default itself is tested through POST /api/workspaces in `auto-approval-routes.test.ts`.
    app.deskmates.ctx.db
      .prepare("UPDATE workspaces SET approval_mode = ? WHERE id = ?")
      .run(options.approvalMode ?? "manual", ws.json.workspace.id);
    // Most tests need an inert registry fixture, not the product's asynchronous first greeting.
    // Bot-creation route tests call POST directly and assert the canonical chat/welcome behavior.
    const bot = app.deskmates.ctx.bots.create({
      name: "alice",
      role: "tester",
      workspaceId: ws.json.workspace.id,
    });
    const thread = app.deskmates.ctx.threads.create({
      workspaceId: ws.json.workspace.id,
      botIds: [bot.id],
    });
    return { workspace: ws.json.workspace, bot, thread };
  };

  return {
    app,
    provider,
    baseUrl,
    api,
    seed,
    close: async () => {
      await app.deskmates.scheduler.drain();
      await app.close();
    },
  };
}

export interface SseClient {
  events: GatewayEvent[];
  close(): void;
}

/** Opens `/api/events` and collects parsed events until closed. */
export async function openSse(baseUrl: string, query = ""): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events${query}`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${TEST_OPERATOR_TOKEN}` },
  });
  if (!res.body) throw new Error("no SSE body");
  const events: GatewayEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = chunk
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) events.push(JSON.parse(data) as GatewayEvent);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted
    }
  })();
  return { events, close: () => controller.abort() };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Resolves on the next macrotask turn, letting a `setImmediate`-scheduled tick run. */
export function nextTurn(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
