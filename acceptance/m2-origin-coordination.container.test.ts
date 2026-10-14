// T2: ADR-0007 candidate origin coordination through real Docker, MCP and SDK processes. A host
// model response is the barrier: run A first completes a browser action, then its fake-model turn
// waits while the run retains the origin. Run B must appear in the ledger queue without its
// request reaching the host. No elapsed-time comparison is an oracle.

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type BotDefinition, type RunEvent, type Thread, isTerminal } from "@deskmates/contracts";
import { gatewayUrlForContainer } from "@deskmates/sandbox-docker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { getRun, postMessage, runEvents, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, takeOver } from "./support/takeover.js";

const TOKEN = "m2-origin-coordination-fake";
const RUN_A = "ORIGIN_QUEUE_RUN_A";
const RUN_B = "ORIGIN_QUEUE_RUN_B";
const TEST_TIMEOUT_MS = 150_000;

interface HostFixture {
  server: Server;
  originForBot: string;
  arrivals: string[];
  close(): Promise<void>;
}

async function startHostFixture(): Promise<HostFixture> {
  const arrivals: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/hold" || url.pathname === "/fast") arrivals.push(url.pathname);
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      url.pathname === "/hold"
        ? "<!doctype html><title>held</title><p>HOLD_REACHED</p>"
        : "<!doctype html><title>fast</title><p>FAST_REACHED</p>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hostUrl = `http://127.0.0.1:${port}`;
  return {
    server,
    originForBot: gatewayUrlForContainer(hostUrl),
    arrivals,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function currentTurnToolResult(
  messages: unknown,
  marker: string,
): { isError: boolean } | undefined {
  const text = JSON.stringify(messages ?? []);
  const trigger = text.lastIndexOf(marker);
  const result = trigger < 0 ? -1 : text.indexOf('"tool_result"', trigger);
  if (result < 0) return undefined;
  return { isError: text.slice(result).includes('"is_error":true') };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function poll<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function originOps(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && event.payload.source === "browser_origin"
      ? [String(event.payload.op)]
      : [],
  );
}

function diagnosticEvents(events: readonly RunEvent[]): RunEvent[] {
  return events.filter(
    (event) => event.kind === "tool_call" || event.kind === "tool_result" || event.kind === "log",
  );
}

async function postInternal<T>(
  stack: Stack,
  runId: string,
  token: string,
  suffix: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${stack.gatewayUrl}/internal/runs/${runId}/${suffix}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as T;
  if (!response.ok) throw new Error(`${suffix}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

const available = await dockerAvailable();
describe.skipIf(!available)(
  "M2 origin coordination (real Docker/MCP/SDK, scripted upstream)",
  () => {
    let fixture: HostFixture;
    let upstream: FakeModelUpstream;
    let stack: Stack;
    let releaseAResponse: ReturnType<typeof deferred>;
    let aUpstreamWaiting = false;
    let aUpstreamError: Error | undefined;

    beforeAll(async () => {
      fixture = await startHostFixture();
      releaseAResponse = deferred();
      upstream = await startFakeModelUpstream({
        expectedToken: TOKEN,
        reply: "done",
        script: async (_turn, body) => {
          const text = JSON.stringify(body?.messages ?? []);
          const tools = JSON.stringify(body?.tools ?? []);
          if (!tools.includes("mcp__browser__browser_navigate"))
            return { kind: "text", text: assistantText("origin queue title") };
          for (const [marker, path] of [
            [RUN_A, "/hold"],
            [RUN_B, "/fast"],
          ] as const) {
            if (!text.includes(marker)) continue;
            const toolResult = currentTurnToolResult(body?.messages, marker);
            if (!toolResult) {
              return {
                kind: "tool_use",
                name: "mcp__browser__browser_navigate",
                input: { url: `${fixture.originForBot}${path}` },
              };
            }
            if (toolResult.isError) {
              const error = new Error(`${marker} browser tool returned an error`);
              if (marker === RUN_A) aUpstreamError = error;
              throw error;
            }
            if (marker === RUN_A) {
              aUpstreamWaiting = true;
              await releaseAResponse.promise;
            }
            return { kind: "text", text: assistantText(`${marker} completed`) };
          }
          return { kind: "text", text: assistantText("unexpected origin fixture prompt") };
        },
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: TOKEN,
        defaultModel: "fake-origin-model",
        cheapModel: "fake-origin-cheap",
        label: "m2-origin-coordination",
      });
      // Opt-in prototype only. The default remains tab-v1 for every other acceptance stack.
      stack.config.browserCoordinationMode = "origin-v2";
      stack.config.runTimeoutSeconds = 120;
    }, 120_000);

    afterAll(async () => {
      releaseAResponse?.resolve();
      await stopStack(stack);
      await upstream?.close();
      await fixture?.close();
    }, 120_000);

    it(
      "queues same-origin browser work at the host barrier and releases it at terminal",
      async () => {
        const created = await stack.api<{
          bot: BotDefinition;
          privateChat: Thread;
          welcomeRun: { id: string };
        }>("POST", "/api/bots", {
          name: "origin-peer",
          role: "origin coordination peer",
          workspaceId: stack.workspace.id,
        });
        expect(created.status, JSON.stringify(created.json)).toBe(201);
        stack.app.deskmates.scheduler.cancel(
          created.json.welcomeRun.id as import("@deskmates/contracts").RunId,
          "test",
        );
        await stack.app.deskmates.scheduler.drain();
        const peer = created.json.privateChat;

        let aRunId: string | undefined;
        let bRunId: string | undefined;
        try {
          const a = await postMessage(stack, RUN_A);
          aRunId = a.run.id;
          await poll("run A reaches the upstream response barrier", async () => {
            if (aUpstreamError) throw aUpstreamError;
            return aUpstreamWaiting ? true : undefined;
          });
          // The SDK can send the next model request before yielding the preceding result to
          // the sidecar ledger. The upstream gate already verified a non-error tool result;
          // assert persisted tool results after releasing the gate and completing the runs.
          expect(fixture.arrivals).toEqual(["/hold"]);

          const b = await postMessage(stack, RUN_B, peer.id);
          bRunId = b.run.id;
          const queued = await poll("run B records its origin queue position", async () => {
            const events = await runEvents(stack, b.run.id);
            if (originOps(events).includes("queued")) return events;
            const current = await getRun(stack, b.run.id);
            if (isTerminal(current.run.status)) {
              throw new Error(
                `run B became ${current.run.status} before queueing: ${JSON.stringify(diagnosticEvents(events))}`,
              );
            }
            return undefined;
          });
          expect(fixture.arrivals).toEqual(["/hold"]);
          expect(originOps(queued)).toContain("queued");

          releaseAResponse.resolve();
          await poll("run B reaches the host after A releases", async () =>
            fixture.arrivals.includes("/fast") ? true : undefined,
          );
          const finals = await Promise.all([
            waitForRun(stack, a.run.id, TEST_TIMEOUT_MS),
            waitForRun(stack, b.run.id, TEST_TIMEOUT_MS),
          ]);
          expect(finals.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);

          const [aEvents, bEvents] = await Promise.all([
            runEvents(stack, a.run.id),
            runEvents(stack, b.run.id),
          ]);
          for (const events of [aEvents, bEvents]) {
            const results = events.filter((event) => event.kind === "tool_result");
            expect(results.length).toBeGreaterThan(0);
            expect(results.every((event) => event.payload.isError !== true)).toBe(true);
          }
          expect(originOps(aEvents)).toEqual(expect.arrayContaining(["granted", "released"]));
          expect(originOps(bEvents)).toEqual(
            expect.arrayContaining(["queued", "granted", "released"]),
          );
          expect(originOps(bEvents).indexOf("queued")).toBeLessThan(
            originOps(bEvents).indexOf("granted"),
          );
          expect(fixture.arrivals).toEqual(["/hold", "/fast"]);

          expect(stack.app.deskmates.ctx.originQueue.list(stack.workspace.id)).toEqual([]);
        } catch (error) {
          const evidence = await Promise.all(
            [aRunId, bRunId]
              .filter((id): id is string => id !== undefined)
              .map(async (id) => ({
                runId: id,
                events: diagnosticEvents(await runEvents(stack, id).catch(() => [])),
              })),
          );
          throw new Error(
            `${String(error)}; origin coordination evidence=${JSON.stringify(evidence)}`,
            { cause: error },
          );
        } finally {
          releaseAResponse.resolve();
          // Drain the real runs before the next case manipulates this workspace's leases.
          await Promise.allSettled(
            [aRunId, bRunId]
              .filter((id): id is string => id !== undefined)
              .map((id) => waitForRun(stack, id, TEST_TIMEOUT_MS)),
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    it("preempts a held origin for takeover and removes terminal queue entries", async () => {
      const ctx = stack.app.deskmates.ctx;
      const makeRun = (triggerRef: string) => {
        const run = ctx.runs.create({
          botId: stack.bot.id,
          lane: triggerRef === "manual-a" ? "interactive" : "background",
          triggerKind: "thread_message",
          triggerRef,
          config: ctx.runConfig(),
        });
        ctx.runs.transition(run.id, "running");
        return { run, token: ctx.tokens.issue(run.id).token };
      };
      const a = makeRun("manual-a");
      const b = makeRun("manual-b");
      try {
        const acquired = await postInternal<{ granted: boolean }>(
          stack,
          a.run.id,
          a.token,
          "browser-origin",
          {
            type: "browser_origin",
            runId: a.run.id,
            op: "acquire",
            origin: fixture.originForBot,
          },
        );
        const queued = await postInternal<{ granted: boolean; waitReason?: string }>(
          stack,
          b.run.id,
          b.token,
          "browser-origin",
          {
            type: "browser_origin",
            runId: b.run.id,
            op: "acquire",
            origin: fixture.originForBot,
          },
        );
        expect(acquired.granted).toBe(true);
        expect(queued).toMatchObject({ granted: false, waitReason: "origin_busy" });
        expect(ctx.originQueue.list(stack.workspace.id).map((entry) => entry.status)).toEqual([
          "held",
          "pending",
        ]);

        await takeOver(stack, "human:origin-test");
        expect(ctx.originQueue.list(stack.workspace.id).map((entry) => entry.status)).toEqual([
          "pending",
          "pending",
        ]);
        expect(originOps(await runEvents(stack, a.run.id))).toContain("preempted");

        for (const item of [a, b]) {
          await postInternal(stack, item.run.id, item.token, "ended", {
            type: "run_ended",
            runId: item.run.id,
            outcome: "failed",
            error: "origin cleanup fixture",
            usage: [],
          });
        }
        expect(ctx.originQueue.list(stack.workspace.id)).toEqual([]);
        for (const item of [a, b]) {
          expect(ctx.runs.mustGet(item.run.id).status).toBe("failed");
          expect(originOps(await runEvents(stack, item.run.id))).toContain("released");
        }
      } finally {
        await handBack(stack).catch(() => undefined);
      }
    });
  },
);
