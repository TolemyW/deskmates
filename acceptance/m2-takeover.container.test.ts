// T2 deskbench X04: two real SDK runs share one Chromium. Bot A reaches the real seeded /mfa
// challenge, the operator takes the workspace over, and bot B's browser call is refused. The
// operator-only CDP helper enters the seeded code on the noVNC-visible tab, hands back, and both
// runs finish on the dashboard. The model fixture never receives the MFA code.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_HOLDS_BROWSER_MESSAGE } from "@deskmates/contracts";
import type { BotDefinition, RunEvent, Thread } from "@deskmates/contracts";
import { MFA_ACCOUNT, MFA_CODE, PASSWORD } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { postMessage, runEvents, waitForRun } from "./support/runs.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, takeOver } from "./support/takeover.js";

const A_PROMPT = "X04_MFA_BOT: log in with the MFA account and reach the dashboard.";
const B_PROMPT = "X04_PEER_BOT: open the dashboard and report the signed-in account.";
const TOKEN = "m2-x04-scripted-token";
const RUN_TIMEOUT_MS = 120_000;
const PEER_BARRIER = "/tmp/deskmates-x04-peer-barrier";
const reportDir = process.env.M2_B3_REPORT_DIR;

interface SseFrame {
  type: string;
  event?: RunEvent;
  browserLock?: unknown;
  [key: string]: unknown;
}

interface Evidence {
  startedAt: string;
  finishedAt?: string;
  error?: string;
  runIds: string[];
  siteBefore?: unknown;
  siteAfter?: unknown;
  events: Record<string, RunEvent[]>;
  sse: SseFrame[];
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  runIds: [],
  events: {},
  sse: [],
};

function evidenceFile(tier: "t2" | "t3"): string {
  const stamp = evidence.startedAt.replace(/[^0-9A-Za-z]+/g, "-");
  return `m2-takeover-${tier}-${stamp}-${evidence.error ? "failed" : "passed"}-raw.json`;
}

function visit(value: unknown, fn: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  fn(record);
  for (const child of Object.values(record)) visit(child, fn);
}

function messageText(body: RecordedUpstreamRequest["body"]): string {
  const out: string[] = [];
  visit(body?.messages, (record) => {
    for (const key of ["text", "content"]) {
      const value = record[key];
      if (typeof value === "string") out.push(value);
    }
  });
  return out.join("\n");
}

function toolUseCount(body: RecordedUpstreamRequest["body"], name: string): number {
  let count = 0;
  visit(body?.messages, (record) => {
    if (record.type === "tool_use" && record.name === name) count += 1;
  });
  return count;
}

function scriptedTurn(_turn: number, body: RecordedUpstreamRequest["body"]): FakeTurn {
  const text = messageText(body);
  const tools = JSON.stringify(body?.tools ?? []);
  if (!tools.includes("mcp__browser__browser_navigate")) {
    return { kind: "text", text: assistantText("x04 title") };
  }
  if (text.includes(A_PROMPT)) {
    if (toolUseCount(body, "mcp__browser__browser_navigate") === 0) {
      return {
        kind: "tool_use",
        name: "mcp__browser__browser_navigate",
        input: { url: `${stack?.siteOriginForBot}/login` },
      };
    }
    if (toolUseCount(body, "mcp__browser__browser_run_code_unsafe") === 0) {
      return {
        kind: "tool_use",
        name: "mcp__browser__browser_run_code_unsafe",
        input: {
          code: `async (page) => { await page.locator('#email').fill(${JSON.stringify(MFA_ACCOUNT)}); await page.locator('#password').fill(${JSON.stringify(PASSWORD)}); await page.locator('#login-submit').click(); await page.waitForURL('**/mfa'); return 'X04_MFA_READY'; }`,
        },
      };
    }
    if (text.includes("Page Title: Dashboard")) {
      return { kind: "text", text: assistantText("A reached dashboard") };
    }
    if (toolUseCount(body, "mcp__browser__browser_wait_for") === 0) {
      // A deterministic observation window: the host waits for the site's /mfa state before it
      // takes over. B is not started until the human lock is already visible.
      return {
        kind: "tool_use",
        name: "mcp__browser__browser_wait_for",
        input: { time: 20 },
      };
    }
    return {
      kind: "tool_use",
      name: "mcp__browser__browser_navigate",
      input: { url: `${stack?.siteOriginForBot}/dashboard` },
    };
  }
  if (text.includes(B_PROMPT)) {
    if (!text.includes("X04_PEER_RELEASED")) {
      return {
        kind: "tool_use",
        name: "Bash",
        input: {
          command: `rm -f ${PEER_BARRIER}; mkfifo ${PEER_BARRIER}; read signal < ${PEER_BARRIER}; rm -f ${PEER_BARRIER}; printf X04_PEER_RELEASED`,
        },
      };
    }
    if (text.includes("Page Title: Dashboard")) {
      return { kind: "text", text: assistantText(`answer: ${MFA_ACCOUNT}`) };
    }
    return {
      kind: "tool_use",
      name: "mcp__browser__browser_navigate",
      input: { url: `${stack?.siteOriginForBot}/dashboard` },
    };
  }
  return { kind: "text", text: assistantText("unexpected prompt") };
}

async function poll<T>(label: string, timeoutMs: number, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function collectFrames(stack: Stack): Promise<{ frames: SseFrame[]; close(): void }> {
  const controller = new AbortController();
  const response = await fetch(`${stack.gatewayUrl}/api/events`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${stack.config.operatorToken}` },
  });
  if (!response.ok) throw new Error(`SSE subscription: HTTP ${response.status}`);
  if (!response.body) throw new Error("SSE response has no body");
  const frames: SseFrame[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) frames.push(JSON.parse(data) as SseFrame);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Expected when the collector is closed in afterAll.
    }
  })();
  return { frames, close: () => controller.abort() };
}

async function solveMfa(stack: Stack): Promise<string> {
  const source = readFileSync(
    new URL("../spikes/m2-takeover/solve-mfa.mjs", import.meta.url),
    "utf8",
  );
  const path = "/work/deskmates-x04-solve-mfa.mjs";
  const wrote = await stack.provider.exec(stack.handle, {
    cmd: ["/bin/sh", "-c", 'cat > "$0"', path],
    stdin: source,
    timeoutMs: 15_000,
  });
  if (wrote.exitCode !== 0) throw new Error(`copy MFA helper: ${wrote.stderr}`);
  const run = await stack.provider.exec(stack.handle, {
    cmd: ["node", path, MFA_CODE, "http://127.0.0.1:9222", stack.siteOriginForBot],
    timeoutMs: 30_000,
  });
  if (run.exitCode !== 0) throw new Error(`solve MFA: ${run.stderr || run.stdout}`);
  const result = /^RESULT (.+)$/m.exec(run.stdout)?.[1];
  if (!result) throw new Error(`MFA helper returned no result: ${run.stdout}`);
  return result.trim();
}

async function releasePeerBarrier(stack: Stack): Promise<void> {
  await poll("peer FIFO appears", 15_000, async () => {
    const probe = await stack.provider.exec(stack.handle, {
      cmd: ["test", "-p", PEER_BARRIER],
      timeoutMs: 1000,
    });
    return probe.exitCode === 0 ? true : undefined;
  });
  const released = await stack.provider.exec(stack.handle, {
    cmd: ["/bin/sh", "-c", 'printf go > "$0"', PEER_BARRIER],
    timeoutMs: 10_000,
  });
  if (released.exitCode !== 0) throw new Error(`release peer barrier: ${released.stderr}`);
}

function waitEvents(events: readonly RunEvent[]): RunEvent[] {
  return events.filter(
    (event) =>
      event.kind === "takeover" &&
      JSON.stringify(event.payload).includes(HUMAN_HOLDS_BROWSER_MESSAGE),
  );
}

let stack: Stack | undefined;
const available = await dockerAvailable();
function requestedSnapshotMode(): "explicit-v1" | "inline-v2" {
  const value = process.env.M2_BROWSER_SNAPSHOT_MODE ?? "explicit-v1";
  if (value !== "explicit-v1" && value !== "inline-v2") {
    throw new Error("M2_BROWSER_SNAPSHOT_MODE must be explicit-v1 or inline-v2");
  }
  return value;
}

const snapshotMode = requestedSnapshotMode();
describe.skipIf(!available)("M2 X04 takeover (real Docker/MCP/SDK, scripted upstream)", () => {
  let upstream: FakeModelUpstream | undefined;
  let frames: Awaited<ReturnType<typeof collectFrames>> | undefined;

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: TOKEN,
      reply: "done",
      script: scriptedTurn,
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: TOKEN,
      defaultModel: "fake-model",
      cheapModel: "fake-cheap-model",
      label: "m2-x04-takeover",
    });
    stack.config.maxTurns = 200;
    stack.config.browserSnapshotMode = snapshotMode;
    frames = await collectFrames(stack);
  }, 120_000);

  afterAll(async () => {
    if (stack) await handBack(stack).catch(() => undefined);
    if (frames) evidence.sse = frames.frames;
    evidence.finishedAt = new Date().toISOString();
    if (reportDir) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, evidenceFile("t2")), JSON.stringify(evidence, null, 2));
    }
    frames?.close();
    await stopStack(stack);
    await upstream?.close();
  }, 120_000);

  it("blocks the peer during MFA takeover, leaks no screenshot, and both runs recover", async () => {
    const s = stack as Stack;
    try {
      evidence.siteBefore = await siteState(s);
      const created = await s.api<{
        bot: BotDefinition;
        privateChat: Thread;
        welcomeRun: { id: string };
      }>("POST", "/api/bots", {
        name: "x04-peer",
        role: "takeover peer",
        workspaceId: s.workspace.id,
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      s.app.deskmates.scheduler.cancel(
        created.json.welcomeRun.id as import("@deskmates/contracts").RunId,
        "test",
      );
      await s.app.deskmates.scheduler.drain();
      const peerThread = created.json.privateChat;

      const a = await postMessage(s, A_PROMPT);
      evidence.runIds.push(a.run.id);
      await poll("bot A reaches /mfa", RUN_TIMEOUT_MS, async () => {
        const state = await siteState(s);
        return state.session.mfa_required && !state.session.mfa_passed ? true : undefined;
      });

      // B is a live run before takeover, but its first browser call is held behind a FIFO. This
      // pins the concurrency without depending on process speed or a timed sleep.
      const b = await postMessage(s, B_PROMPT, peerThread.id);
      evidence.runIds.push(b.run.id);
      await poll("peer reaches its pre-browser barrier", RUN_TIMEOUT_MS, async () => {
        const events = await runEvents(s, b.run.id);
        return events.some(
          (event) => event.kind === "tool_call" && event.payload.toolName === "Bash",
        )
          ? true
          : undefined;
      });

      const takeover = await takeOver(s, "human:x04-test");
      expect(takeover.lock.holderKind).toBe("human");
      expect(Object.keys(takeover), "the lease only (C7)").toEqual(["lock"]);
      const takenFrame = await poll("SSE takeover frame", 10_000, async () =>
        frames?.frames.findIndex(
          (frame) => frame.type === "workspace_lock" && frame.browserLock !== null,
        ) === -1
          ? undefined
          : true,
      );
      expect(takenFrame).toBe(true);

      await releasePeerBarrier(s);
      await poll("peer takeover refusal", RUN_TIMEOUT_MS, async () => {
        const events = await runEvents(s, b.run.id);
        return waitEvents(events)[0];
      });

      const landed = await solveMfa(s);
      expect(landed).toMatch(/\/dashboard$/);
      expect(await handBack(s)).toEqual({ released: true });
      await poll("SSE handback frame", 10_000, async () => {
        const locks = frames?.frames.filter((frame) => frame.type === "workspace_lock") ?? [];
        return locks.at(-1)?.browserLock === null ? true : undefined;
      });

      const finals = await Promise.all([
        waitForRun(s, a.run.id, RUN_TIMEOUT_MS),
        waitForRun(s, b.run.id, RUN_TIMEOUT_MS),
      ]);
      expect(
        finals.map((run) => run.status),
        finals.map((run) => run.error).join("\n"),
      ).toEqual(["succeeded", "succeeded"]);

      for (const runId of evidence.runIds) evidence.events[runId] = await runEvents(s, runId);
      const aEvents = evidence.events[a.run.id] ?? [];
      const bEvents = evidence.events[b.run.id] ?? [];
      expect(
        waitEvents(bEvents).length,
        "peer ledger carries the workspace wait reason",
      ).toBeGreaterThan(0);
      expect(
        (upstream as FakeModelUpstream).requests.some((request) =>
          messageText(request.body).includes(HUMAN_HOLDS_BROWSER_MESSAGE),
        ),
        "the wait result reached the scripted model on the wire",
      ).toBe(true);

      const takenSeq = aEvents.find(
        (event) => event.kind === "takeover" && event.payload.phase === "taken",
      )?.seq;
      const returnedSeq = aEvents.find(
        (event) => event.kind === "takeover" && event.payload.phase === "handed_back",
      )?.seq;
      expect(takenSeq).toBeTypeOf("number");
      expect(returnedSeq).toBeTypeOf("number");
      expect(
        aEvents.filter(
          (event) =>
            event.kind === "screenshot" &&
            event.seq > (takenSeq ?? 0) &&
            event.seq < (returnedSeq ?? Number.POSITIVE_INFINITY),
        ),
        "the ledger stores no screenshots while the human owns the browser",
      ).toEqual([]);

      const lockFrames =
        frames?.frames
          .map((frame, index) => ({ frame, index }))
          .filter(({ frame }) => frame.type === "workspace_lock") ?? [];
      const from = lockFrames.find(({ frame }) => frame.browserLock !== null)?.index ?? -1;
      const to =
        lockFrames.find(({ frame, index }) => index > from && frame.browserLock === null)?.index ??
        -1;
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      expect(
        frames?.frames
          .slice(from + 1, to)
          .filter((frame) => frame.type === "run_event" && frame.event?.kind === "screenshot") ??
          [],
        "SSE emits no screenshot frame during takeover",
      ).toEqual([]);

      const tabIds = [aEvents, bEvents].map(
        (events) =>
          events.find(
            (event) =>
              event.kind === "log" &&
              event.payload.source === "browser_lock" &&
              event.payload.op === "tab_acquired",
          )?.payload.tabId,
      );
      expect(tabIds.every((id) => typeof id === "string")).toBe(true);
      expect(new Set(tabIds).size).toBe(2);

      evidence.siteAfter = await siteState(s);
      expect(evidence.siteAfter).toMatchObject({
        session: { logged_in: true, user: MFA_ACCOUNT, mfa_required: true, mfa_passed: true },
      });
    } catch (error) {
      evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
      if (stack) {
        for (const runId of evidence.runIds) {
          evidence.events[runId] = await runEvents(stack, runId).catch(() => []);
        }
        evidence.siteAfter = await siteState(stack).catch(() => undefined);
      }
      throw error;
    }
  }, 180_000);
});
