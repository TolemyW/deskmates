// T3 deskbench X04 with the configured model. Two bots are already running when the operator
// takes the workspace Chromium over: A is stopped at the golden site's real /mfa page and B is
// held at a deterministic pre-browser FIFO. Releasing B under the human lock proves its browser
// tools wait; the operator-only CDP helper enters the seeded code, handback restores both tabs,
// and both bots complete their dashboard targets.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_HOLDS_BROWSER_MESSAGE, botHomeDir, isTerminal } from "@deskmates/contracts";
import type { BotDefinition, RunEvent, Thread } from "@deskmates/contracts";
import { MFA_ACCOUNT, MFA_CODE, PASSWORD } from "@deskmates/golden-site";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCanonicalSoul } from "./support/canonical-soul.js";
import { dockerAvailable } from "./support/docker.js";
import { missingModelEnv, modelEnv, skipReason } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import { type X04TakeoverChecks, failedX04TakeoverChecks } from "./support/m2-takeover-oracle.js";
import {
  answerOf,
  getRun,
  postMessage,
  runEvents,
  threadMessages,
  toolNameOf,
  waitForRun,
} from "./support/runs.js";
import { siteState } from "./support/site.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";
import { handBack, takeOver } from "./support/takeover.js";

const RUN_TIMEOUT_MS = 8 * 60_000;
const PEER_BARRIER = "/tmp/deskmates-x04-model-peer-barrier";
const reportDir = process.env.M2_B3_REPORT_DIR;
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);
const A_PROMPT = [
  `Log in to the Galaxy Ops Console with email ${MFA_ACCOUNT} and password ${PASSWORD}.`,
  "Reach the dashboard. The six-digit authenticator code must be entered by a human; never",
  "guess or type it yourself. Keep this run alive while the human operates the browser, then",
  "continue after handback. End with exactly `answer: dashboard` once Dashboard is visible.",
  "Your final reply must be that one line only; any other final reply fails the task.",
].join(" ");
const B_PROMPT = [
  `First run this exact Bash command and wait for it to finish: \`rm -f ${PEER_BARRIER}; mkfifo ${PEER_BARRIER}; read signal < ${PEER_BARRIER}; rm -f ${PEER_BARRIER}; printf X04_PEER_RELEASED\`.`,
  "Then open the Galaxy Ops Console dashboard in the browser and",
  `report the signed-in account. End with exactly \`answer: ${MFA_ACCOUNT}\`.`,
  "Your final reply must be that one line only; any other final reply fails the task.",
].join(" ");

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
  events: Record<string, RunEvent[]>;
  replies: Record<string, string | undefined>;
  messages: Record<string, string[]>;
  finalStatuses: Record<string, string>;
  checks: Record<string, boolean>;
  siteBefore?: unknown;
  siteAfter?: unknown;
  sse: SseFrame[];
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  runIds: [],
  events: {},
  replies: {},
  messages: {},
  finalStatuses: {},
  checks: {},
  sse: [],
};

function evidenceFile(tier: "t2" | "t3"): string {
  const stamp = evidence.startedAt.replace(/[^0-9A-Za-z]+/g, "-");
  return `m2-takeover-${tier}-${stamp}-${evidence.error ? "failed" : "passed"}-raw.json`;
}

function takeoverSoul(botName: string, siteOrigin: string): string {
  return [
    `# ${botName}`,
    "",
    `You are ${botName}, an operations assistant for ${siteOrigin}.`,
    "Use browser tools for console work. Each run has its own tab in the shared browser.",
    "",
    "## Rules",
    "- Do exactly what the human message asks and keep replies short.",
    "- Never guess, obtain, or enter an authenticator code. A human enters it during takeover.",
    "- If a browser tool says a human is operating the browser, do not stop the run. Use Bash",
    "  `sleep 3`, then retry the same browser step. Continue until the browser is handed back.",
    "- Return the exact requested `answer: <value>` line only after you see the target page.",
    "- Your final reply must contain only that one answer line. Extra prose fails the task.",
  ].join("\n");
}

async function poll<T>(label: string, timeoutMs: number, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
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
      // Expected when afterAll closes the stream.
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
  await poll("peer FIFO appears", 30_000, async () => {
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

function successfulBrowserResultAfter(events: readonly RunEvent[], seq: number): boolean {
  const calls = new Set(
    events
      .filter(
        (event) =>
          event.seq > seq && event.kind === "tool_call" && toolNameOf(event).startsWith("browser_"),
      )
      .map((event) => event.payload.toolUseId)
      .filter((id): id is string => typeof id === "string"),
  );
  return events.some(
    (event) =>
      event.seq > seq &&
      event.kind === "tool_result" &&
      typeof event.payload.toolUseId === "string" &&
      calls.has(event.payload.toolUseId) &&
      event.payload.isError !== true &&
      !String(event.payload.content ?? "").includes(HUMAN_HOLDS_BROWSER_MESSAGE),
  );
}

function successfulBrowserResultMatchingAfter(
  events: readonly RunEvent[],
  seq: number,
  pattern: RegExp,
): boolean {
  const calls = new Set(
    events
      .filter(
        (event) =>
          event.seq > seq && event.kind === "tool_call" && toolNameOf(event).startsWith("browser_"),
      )
      .map((event) => event.payload.toolUseId)
      .filter((id): id is string => typeof id === "string"),
  );
  return events.some(
    (event) =>
      event.seq > seq &&
      event.kind === "tool_result" &&
      typeof event.payload.toolUseId === "string" &&
      calls.has(event.payload.toolUseId) &&
      event.payload.isError !== true &&
      pattern.test(String(event.payload.content ?? "")),
  );
}

const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const skip = missing.length > 0 || !dockerUp;
if (skip) console.warn(`[m2-takeover.acceptance.test]${skipReason(missing, dockerUp)}`);

let stack: Stack | undefined;
describe.skipIf(skip)(
  `M2 X04 takeover (two configured-model bots)${skipReason(missing, dockerUp)}`,
  () => {
    let frames: Awaited<ReturnType<typeof collectFrames>> | undefined;

    beforeAll(async () => {
      stack = await startStack({
        ...modelEnv(),
        label: "m2-x04-takeover-model",
        botName: "x04-mfa-bot",
        soul: takeoverSoul,
      });
      stack.config.browserSnapshotMode = snapshotMode;
      frames = await collectFrames(stack);
    }, 25 * 60_000);

    afterAll(async () => {
      if (stack) await handBack(stack).catch(() => undefined);
      if (frames) evidence.sse = frames.frames;
      evidence.finishedAt = new Date().toISOString();
      if (reportDir) {
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, evidenceFile("t3")), JSON.stringify(evidence, null, 2));
      }
      frames?.close();
      await stopStack(stack);
    }, 120_000);

    it(
      "hands the MFA screen to a human while both bots are live, then both complete",
      async () => {
        const s = stack as Stack;
        try {
          evidence.siteBefore = await siteState(s);
          const peerName = "x04-peer-bot";
          const created = await s.api<{ bot: BotDefinition }>("POST", "/api/bots", {
            name: peerName,
            role: "takeover peer",
            workspaceId: s.workspace.id,
          });
          expect(created.status, JSON.stringify(created.json)).toBe(201);
          const soul = takeoverSoul(peerName, s.siteOriginForBot);
          const wrote = await s.provider.exec(s.handle, {
            cmd: [
              "/bin/sh",
              "-c",
              'mkdir -p "$(dirname "$0")" && cat > "$0"',
              `${botHomeDir(peerName)}/SOUL.md`,
            ],
            stdin: soul,
            timeoutMs: 15_000,
          });
          expect(wrote.exitCode, wrote.stderr).toBe(0);
          await setCanonicalSoul(s.api, created.json.bot.id, soul, peerName);
          const peerThread = await s.api<{ thread: Thread }>("POST", "/api/threads", {
            workspaceId: s.workspace.id,
            botIds: [created.json.bot.id],
            title: "X04 takeover peer",
          });
          expect(peerThread.status, JSON.stringify(peerThread.json)).toBe(201);

          const a = await postMessage(s, A_PROMPT);
          evidence.runIds.push(a.run.id);
          await poll("MFA bot reaches /mfa", RUN_TIMEOUT_MS, async () => {
            const run = (await getRun(s, a.run.id)).run;
            if (isTerminal(run.status)) {
              throw new Error(`MFA bot ended ${run.status} before takeover: ${run.error ?? ""}`);
            }
            const state = await siteState(s);
            if (state.session.mfa_passed) {
              throw new Error("MFA passed before the operator helper ran");
            }
            return state.session.mfa_required ? true : undefined;
          });

          const b = await postMessage(s, B_PROMPT, peerThread.json.thread.id);
          evidence.runIds.push(b.run.id);
          await poll("peer reaches pre-browser FIFO", RUN_TIMEOUT_MS, async () => {
            const run = (await getRun(s, b.run.id)).run;
            if (isTerminal(run.status)) {
              throw new Error(`peer ended ${run.status} before takeover: ${run.error ?? ""}`);
            }
            const events = await runEvents(s, b.run.id);
            return events.some(
              (event) => event.kind === "tool_call" && event.payload.toolName === "Bash",
            )
              ? true
              : undefined;
          });

          for (const runId of [a.run.id, b.run.id]) {
            const live = (await getRun(s, runId)).run;
            expect(
              isTerminal(live.status),
              `${runId} ended before takeover: ${live.error ?? ""}`,
            ).toBe(false);
          }

          const takeover = await takeOver(s, "human:x04-acceptance");
          expect(takeover.lock.holderKind).toBe("human");
          expect(Object.keys(takeover), "the lease only (C7)").toEqual(["lock"]);
          await releasePeerBarrier(s);
          await poll("peer browser wait event", RUN_TIMEOUT_MS, async () => {
            const events = await runEvents(s, b.run.id);
            return waitEvents(events)[0];
          });

          expect(await solveMfa(s)).toMatch(/\/dashboard$/);
          expect(await handBack(s)).toEqual({ released: true });
          await poll("SSE handback", 10_000, async () => {
            const locks = frames?.frames.filter((frame) => frame.type === "workspace_lock") ?? [];
            return locks.at(-1)?.browserLock === null ? true : undefined;
          });

          const finals = await Promise.all([
            waitForRun(s, a.run.id, RUN_TIMEOUT_MS),
            waitForRun(s, b.run.id, RUN_TIMEOUT_MS),
          ]);
          evidence.finalStatuses[a.run.id] = finals[0]?.status ?? "missing";
          evidence.finalStatuses[b.run.id] = finals[1]?.status ?? "missing";

          for (const runId of evidence.runIds) {
            evidence.events[runId] = await runEvents(s, runId);
          }
          // A uses thread_post for the human-needed notice, so the first bot message is an
          // intermediate message. The final reply is the last message authored by that run.
          const messagesFor = async (threadId: Thread["id"], runId: string): Promise<string[]> =>
            (await threadMessages(s, threadId))
              .filter((message) => message.authorKind === "bot" && message.runId === runId)
              .map((message) => message.body);
          evidence.messages[a.run.id] = await messagesFor(s.thread.id, a.run.id);
          evidence.messages[b.run.id] = await messagesFor(peerThread.json.thread.id, b.run.id);
          evidence.replies[a.run.id] = evidence.messages[a.run.id]?.at(-1);
          evidence.replies[b.run.id] = evidence.messages[b.run.id]?.at(-1);

          const aEvents = evidence.events[a.run.id] ?? [];
          const bEvents = evidence.events[b.run.id] ?? [];
          const aTaken = aEvents.find(
            (event) => event.kind === "takeover" && event.payload.phase === "taken",
          );
          const bTaken = bEvents.find(
            (event) => event.kind === "takeover" && event.payload.phase === "taken",
          );
          const aReturned = aEvents.find(
            (event) => event.kind === "takeover" && event.payload.phase === "handed_back",
          );
          const bReturned = bEvents.find(
            (event) => event.kind === "takeover" && event.payload.phase === "handed_back",
          );

          const lockFrames =
            frames?.frames
              .map((frame, index) => ({ frame, index }))
              .filter(({ frame }) => frame.type === "workspace_lock") ?? [];
          const from = lockFrames.find(({ frame }) => frame.browserLock !== null)?.index ?? -1;
          const to =
            lockFrames.find(({ frame, index }) => index > from && frame.browserLock === null)
              ?.index ?? -1;
          const state = await siteState(s);
          evidence.siteAfter = state;
          const ledgerHasNoTakeoverScreenshots = [
            { events: aEvents, taken: aTaken?.seq, returned: aReturned?.seq },
            { events: bEvents, taken: bTaken?.seq, returned: bReturned?.seq },
          ].every(({ events, taken, returned }) =>
            events.every(
              (event) =>
                event.kind !== "screenshot" ||
                event.seq <= (taken ?? 0) ||
                event.seq >= (returned ?? Number.POSITIVE_INFINITY),
            ),
          );
          const sseHasNoTakeoverScreenshots =
            from >= 0 &&
            to > from &&
            !frames?.frames
              .slice(from + 1, to)
              .some((frame) => frame.type === "run_event" && frame.event?.kind === "screenshot");
          const tabIds = [aEvents, bEvents].map(
            (events) =>
              events.find(
                (event) =>
                  event.kind === "log" &&
                  event.payload.source === "browser_lock" &&
                  event.payload.op === "tab_acquired",
              )?.payload.tabId,
          );

          const canonicalChecks: X04TakeoverChecks = {
            bothRunsSucceeded: finals.every((run) => run.status === "succeeded"),
            bothRunsMarkedTaken: aTaken !== undefined && bTaken !== undefined,
            bothRunsMarkedHandedBack: aReturned !== undefined && bReturned !== undefined,
            peerSawWaitEvent: waitEvents(bEvents).length > 0,
            aSawDashboardAfterHandback: successfulBrowserResultMatchingAfter(
              aEvents,
              aReturned?.seq ?? Number.MAX_SAFE_INTEGER,
              /Page URL: .*\/dashboard|Page Title: Dashboard - Galaxy Ops Console/,
            ),
            bUsedBrowserAfterHandback: successfulBrowserResultAfter(
              bEvents,
              bReturned?.seq ?? Number.MAX_SAFE_INTEGER,
            ),
            separateTabs:
              tabIds.every((id) => typeof id === "string") && new Set(tabIds).size === 2,
            ledgerHasNoTakeoverScreenshots,
            sseHasNoTakeoverScreenshots,
            siteMfaPassed:
              state.session.logged_in &&
              state.session.user === MFA_ACCOUNT &&
              state.session.mfa_required &&
              state.session.mfa_passed,
          };
          // X04 has no answer oracle. Keep these as diagnostics because the prompts in this
          // frozen stimulus requested the answer-line convention, but do not gate X04 on them.
          evidence.checks = {
            ...canonicalChecks,
            aFinalAnswerFormat:
              evidence.replies[a.run.id]?.trim() === "answer: dashboard" &&
              answerOf(evidence.replies[a.run.id]) === "dashboard",
            bFinalAnswerFormat:
              evidence.replies[b.run.id]?.trim() === `answer: ${MFA_ACCOUNT}` &&
              answerOf(evidence.replies[b.run.id]) === MFA_ACCOUNT,
          };
          expect(
            failedX04TakeoverChecks(canonicalChecks),
            JSON.stringify(evidence.checks, null, 2),
          ).toEqual([]);
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
      },
      3 * RUN_TIMEOUT_MS,
    );
  },
);
