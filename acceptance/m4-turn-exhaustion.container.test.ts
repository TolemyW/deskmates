// T2: ADR-0016 on the real stack (Gateway, workspace container, sidecar, Agent SDK 0.3.278) with a
// scripted upstream, no model. A chief bot delegates to a worker in one thread; the worker keeps
// calling tools until its turn budget runs out. The cases follow one journey in order, one per
// Verification row: the PostToolUse turn warning reaches the next model request (item 1), the
// exhausted run parks as `waiting_continuation` with its session and a request that wakes only
// the delegator (items 2 and 3), the delegator's `approval_decide` resumes the same SDK session as
// attempt 2 (item 4), and the resumed run's end reaches the delegator as an outcome notice (item 8).
import type {
  Approval,
  BotDefinition,
  RunEvent,
  Thread,
  ThreadMessage,
} from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingApprovals } from "./support/approvals.js";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import {
  createGroupBot,
  createGroupThread,
  groupMessages,
  groupRunEvents,
  postGroupMessage,
  threadRuns,
} from "./support/m2-group.js";
import { POLL_MS, type RunView } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const TOKEN = "adr16-turn-exhaustion-fake";
const CHIEF = "adr16_chief";
const WORKER = "adr16_worker";
const CHIEF_SOUL = "# adr16 chief\nADR16_SOUL_CHIEF: delegate ADR16_DELEGATE to the worker.";
const WORKER_SOUL = "# adr16 worker\nADR16_SOUL_WORKER: work on ADR16_WORK with the shell.";
const MAX_TURNS = 12;
const WARNING = "Turn budget warning:";
const CONTINUATION_PROMPT = "The delegator approved continuation";
const REQUEST_MARKER = "-turn attempt limit";
const NOTICE_MARKER = "finished the work";
const MODEL_HANDOFF = "/work/adr16-handoff.md";
const JOURNEY_TIMEOUT_MS = 180_000;

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

/** Assistant tool calls already in the request's history: one per earlier model turn here. */
function toolUses(body: RecordedUpstreamRequest["body"]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  visit(body?.messages, (record) => {
    if (record.type === "tool_use") found.push(record);
  });
  return found;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function hasTools(body: RecordedUpstreamRequest["body"]): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

function isBot(body: RecordedUpstreamRequest["body"], marker: string): boolean {
  return hasTools(body) && JSON.stringify(body?.system ?? "").includes(marker);
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe.skipIf(!available)("ADR-0016 turn exhaustion (real Docker/SDK, scripted upstream)", () => {
  let upstream: FakeModelUpstream | undefined;
  let stack: Stack | undefined;
  let chief: BotDefinition;
  let worker: BotDefinition;
  let thread: Thread;
  let workerRun: RunView;
  let parkedSessionId: string | undefined;
  let requestMessage: ThreadMessage | undefined;
  let continuation: Approval | undefined;

  // The chief's decision turn is held until the parked state has been inspected, so the test
  // observes `waiting_continuation` instead of racing the delegator's resume.
  let releaseDecision: () => void = () => undefined;
  const decisionGate = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  let decisionRequested: () => void = () => undefined;
  const decisionReached = new Promise<void>((resolve) => {
    decisionRequested = resolve;
  });

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: TOKEN,
      reply: "",
      script: async (_turn, body): Promise<FakeTurn> => {
        if (!hasTools(body)) return { kind: "text", text: assistantText("") };
        const conversation = JSON.stringify(body?.messages ?? []);

        if (isBot(body, "ADR16_SOUL_WORKER")) {
          if (conversation.includes(CONTINUATION_PROMPT)) {
            return { kind: "text", text: assistantText("ADR16_DONE") };
          }
          const uses = toolUses(body);
          const wroteHandoff = uses.some((use) => use.name === "Write");
          if (conversation.includes(WARNING) && !wroteHandoff) {
            return {
              kind: "tool_use",
              name: "Write",
              input: {
                file_path: MODEL_HANDOFF,
                content: `ADR16 handoff: ${uses.length} steps done, the rest remains.\n`,
              },
            };
          }
          return {
            kind: "tool_use",
            name: "Bash",
            input: { command: `echo ADR16_STEP_${uses.length + 1}`, description: "one step" },
          };
        }

        if (isBot(body, "ADR16_SOUL_CHIEF")) {
          const delegated = conversation.lastIndexOf("ADR16_DELEGATE");
          const asked = conversation.lastIndexOf(REQUEST_MARKER);
          const noticed = conversation.lastIndexOf(NOTICE_MARKER);
          const latest = Math.max(delegated, asked, noticed);
          if (conversation.lastIndexOf('"tool_result"') > latest) {
            return { kind: "text", text: assistantText("") };
          }
          if (latest === asked) {
            decisionRequested();
            await decisionGate;
            const ids = [
              ...conversation
                .slice(asked)
                .matchAll(/approval_decide\(([A-Za-z0-9_-]+), allow_once\)/g),
            ];
            const approvalId = ids.at(-1)?.[1];
            if (!approvalId) return { kind: "text", text: assistantText("no approval id seen") };
            return {
              kind: "tool_use",
              name: "mcp__deskmates__approval_decide",
              input: { approvalId, decision: "allow_once", reason: "ADR16 continue" },
            };
          }
          if (latest === delegated) {
            return {
              kind: "tool_use",
              name: "mcp__deskmates__thread_post",
              input: { body: `@${WORKER} ADR16_WORK`, attachments: [] },
            };
          }
          return { kind: "text", text: assistantText("") };
        }

        return { kind: "text", text: assistantText("") };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: TOKEN,
      defaultModel: "fake-adr16",
      cheapModel: "fake-adr16-cheap",
      label: "adr16-turns",
      botName: "adr16_bootstrap",
    });
    stack.config.maxTurns = MAX_TURNS;
    stack.config.runTimeoutSeconds = 180;
    chief = await createGroupBot(stack, { name: CHIEF, role: "delegator", soul: CHIEF_SOUL });
    worker = await createGroupBot(stack, { name: WORKER, role: "delegate", soul: WORKER_SOUL });
    thread = await createGroupThread(stack, [chief, worker], "ADR-0016 turn exhaustion");
  }, 180_000);

  afterAll(async () => {
    releaseDecision();
    await stopStack(stack);
    await upstream?.close();
  }, 120_000);

  const workerRequests = (): RecordedUpstreamRequest[] =>
    (upstream as FakeModelUpstream).requests.filter((r) => isBot(r.body, "ADR16_SOUL_WORKER"));
  const chiefRequests = (): RecordedUpstreamRequest[] =>
    (upstream as FakeModelUpstream).requests.filter((r) => isBot(r.body, "ADR16_SOUL_CHIEF"));
  const runsOf = async (bot: BotDefinition): Promise<RunView[]> =>
    (await threadRuns(stack as Stack, thread))
      .filter((run) => run.botId === bot.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  it(
    "item 1: the PostToolUse warning reaches the model once, with 5 turns left",
    async () => {
      const s = stack as Stack;
      await postGroupMessage(s, thread, `@${CHIEF} ADR16_DELEGATE`);
      await Promise.race([
        decisionReached,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("the delegator was not asked to decide a continuation")),
            JOURNEY_TIMEOUT_MS,
          ),
        ),
      ]);
      const workers = await runsOf(worker);
      expect(workers).toHaveLength(1);
      workerRun = workers[0] as RunView;

      const attempt1 = workerRequests().filter(
        (r) => !JSON.stringify(r.body?.messages ?? []).includes(CONTINUATION_PROMPT),
      );
      // One model request per SDK turn: the SDK stops after maxTurns responses.
      expect(attempt1).toHaveLength(MAX_TURNS);
      for (const request of attempt1) {
        const prior = toolUses(request.body).length;
        const warnings = occurrences(request.rawBody, WARNING);
        // The warning is added after the tool of turn 7 (12 - 7 = 5 left), so it is first seen by
        // the request of turn 8, and from then on stays in the history exactly once.
        expect(warnings, `request after ${prior} tool turns`).toBe(prior >= 7 ? 1 : 0);
      }
      const eighth = attempt1.find((r) => toolUses(r.body).length === 7);
      expect(eighth?.rawBody).toContain(`${WARNING} 5 assistant turns remain in this attempt.`);
      // The scripted model acted on it: its next call wrote a handoff under /work.
      const ninth = attempt1.find((r) => toolUses(r.body).length === 8);
      expect(toolUses(ninth?.body).at(-1)?.name).toBe("Write");

      const events = await groupRunEvents(s, workerRun);
      const warned = events.filter(
        (event) => event.kind === "log" && event.payload.source === "turn_budget",
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]?.attempt).toBe(1);
    },
    JOURNEY_TIMEOUT_MS + 30_000,
  );

  it("items 2-3: exhaustion parks waiting_continuation and asks only the delegator", async () => {
    const s = stack as Stack;
    const run = await waitFor("the parked worker run", 30_000, async () => {
      const current = (await runsOf(worker))[0];
      return current?.status === "waiting_continuation" ? current : undefined;
    });
    expect(run.attempt).toBe(1);
    const record = s.app.deskmates.ctx.runs.mustGet(run.id);
    parkedSessionId = record.sdkSessionId;
    expect(parkedSessionId).toBeTruthy();
    expect(record.resumePayload).toMatchObject({
      sdkSessionId: parkedSessionId,
      continuation: true,
    });
    expect(record.config.continuationCount).toBe(0);
    expect(record.config.continuationLimit).toBe(2);
    expect(s.app.deskmates.ctx.sessions.get(worker.id, thread.id)).toBe(parkedSessionId);

    const handoffPath = `/work/handoffs/${run.id}-attempt-1.md`;
    expect(record.config.handoffPath).toBe(handoffPath);
    const handoff = await s.provider.exec(s.handle, {
      cmd: ["cat", handoffPath],
      timeoutMs: 15_000,
    });
    expect(handoff.exitCode, handoff.stderr).toBe(0);
    expect(handoff.stdout).toContain(`Run: ${run.id}`);
    const modelHandoff = await s.provider.exec(s.handle, {
      cmd: ["cat", MODEL_HANDOFF],
      timeoutMs: 15_000,
    });
    expect(modelHandoff.stdout).toContain("ADR16 handoff");

    const pending = (await pendingApprovals(s, thread.id)).filter((a) => a.runId === run.id);
    expect(pending).toHaveLength(1);
    continuation = pending[0] as Approval;
    expect(continuation.kind).toBe("continuation");
    expect(continuation.action.toolName).toBe("__run_continuation__");
    expect(continuation.instruction).toBe(`@${WORKER} ADR16_WORK`);

    const messages = await groupMessages(s, thread);
    const delegation = messages.find(
      (m) => m.authorKind === "bot" && m.authorId === chief.id && m.body.includes("ADR16_WORK"),
    );
    expect(delegation).toBeDefined();
    expect(run.triggerRef).toBe(delegation?.id);
    requestMessage = messages.find((m) => m.id === continuation?.messageId);
    expect(requestMessage?.authorKind).toBe("system");
    const body = requestMessage?.body ?? "";
    expect(body).toContain(WORKER);
    expect(body).toContain(`reached the ${MAX_TURNS}-turn attempt limit`);
    expect(body).toMatch(/\d+ model turns observed across 1 attempt\(s\); \d+ recorded tokens/);
    expect(body).toContain(`Delegating message: ${delegation?.id}`);
    expect(body).toContain(`Handoff: ${handoffPath}`);
    expect(body).not.toContain("ADR16_STEP_");
    expect(body).toContain(`approval_decide(${continuation.id}, allow_once)`);

    // Only the delegator is woken by the request: one chief run, nothing for the worker.
    const woken = (await threadRuns(s, thread)).filter((r) => r.triggerRef === requestMessage?.id);
    expect(woken.map((r) => r.botId)).toEqual([chief.id]);
    expect(await runsOf(worker)).toHaveLength(1);
    const events = await groupRunEvents(s, run);
    expect(
      events.some((e) => e.kind === "approval" && e.payload.phase === "continuation_requested"),
    ).toBe(true);
    // The request reached the delegator's model with the approval id it decides.
    expect(
      chiefRequests().some((r) =>
        r.rawBody.includes(`approval_decide(${continuation?.id}, allow_once)`),
      ),
    ).toBe(true);
  }, 60_000);

  it(
    "item 4: the delegator's continue resumes attempt 2 with resume: sessionId",
    async () => {
      const s = stack as Stack;
      const before = workerRequests().length;
      releaseDecision();
      const done = await waitFor("the resumed worker run to end", JOURNEY_TIMEOUT_MS, async () => {
        const current = (await runsOf(worker))[0];
        if (!current) return undefined;
        if (current.status === "failed" || current.status === "stopped") {
          throw new Error(`worker run ended ${current.status}: ${current.error ?? ""}`);
        }
        return current.status === "succeeded" ? current : undefined;
      });
      expect(done.id).toBe(workerRun.id);
      expect(done.attempt).toBe(2);
      expect(await runsOf(worker)).toHaveLength(1);

      const decided = s.app.deskmates.ctx.approvals.mustGet((continuation as Approval).id);
      expect(decided.decision).toBe("allow_once");
      expect(decided.decidedBy).toBe(`bot:${chief.id}`);
      const record = s.app.deskmates.ctx.runs.mustGet(done.id);
      expect(record.config.continuationCount).toBe(1);
      expect(record.sdkSessionId).toBe(parkedSessionId);

      // The resumed process reopened the parked SDK session: its first request carries attempt 1's
      // tool history, the warning, and the continuation prompt naming the sidecar's handoff.
      const attempt2 = workerRequests().slice(before);
      expect(attempt2.length).toBeGreaterThanOrEqual(1);
      const first = attempt2[0] as RecordedUpstreamRequest;
      expect(first.rawBody).toContain(CONTINUATION_PROMPT);
      expect(first.rawBody).toContain(`/work/handoffs/${done.id}-attempt-1.md`);
      expect(toolUses(first.body)).toHaveLength(MAX_TURNS);
      expect(first.rawBody).toContain("ADR16_STEP_1");
      expect(occurrences(first.rawBody, WARNING)).toBe(1);

      const events: RunEvent[] = await groupRunEvents(s, done);
      const resumed = events.filter((e) => e.kind === "approval" && e.payload.phase === "resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.payload.attempt).toBe(2);
      // Both processes reported model turns, each under its own attempt.
      const turnAttempts = events.filter((e) => e.kind === "turn_usage").map((e) => e.attempt);
      expect(new Set(turnAttempts)).toEqual(new Set([1, 2]));
      const messages = await groupMessages(s, thread);
      expect(
        messages.some((m) => m.authorKind === "system" && m.body.startsWith("Continued by bot:")),
      ).toBe(true);
    },
    JOURNEY_TIMEOUT_MS + 30_000,
  );

  it(
    "item 8: the resumed run's end reaches the delegator as an outcome notice",
    async () => {
      const s = stack as Stack;
      const chiefRuns = await waitFor(
        "the delegator's notice run",
        JOURNEY_TIMEOUT_MS,
        async () => {
          const runs = await runsOf(chief);
          return runs.length >= 3 &&
            runs.every((run) => ["succeeded", "silent"].includes(run.status))
            ? runs
            : undefined;
        },
      );
      // A quiet window: nothing further is woken by the notice.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await runsOf(chief)).toHaveLength(3);
      expect(await runsOf(worker)).toHaveLength(1);

      const messages = await groupMessages(s, thread);
      const reply = messages.find(
        (m) => m.authorKind === "bot" && m.authorId === worker.id && m.body.includes("ADR16_DONE"),
      );
      expect(reply?.runId).toBe(workerRun.id);
      const notices = messages.filter(
        (m) => m.authorKind === "system" && m.body.includes(NOTICE_MARKER),
      );
      expect(notices).toHaveLength(1);
      const notice = notices[0] as ThreadMessage;
      expect(notice.body).toContain(WORKER);
      expect(notice.body).toContain(`message #${reply?.seq}`);
      expect(notice.seq).toBeGreaterThan(requestMessage?.seq ?? 0);

      const events = await groupRunEvents(s, workerRun);
      const logged = events.filter(
        (e) => e.kind === "log" && e.payload.source === "delegation_outcome",
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]?.payload.delegatorBotId).toBe(chief.id);
      expect(logged[0]?.payload.messageIds).toContain(notice.id);

      // The third chief run is the delegator hearing the outcome: its model request has the notice.
      const third = chiefRuns[2] as RunView;
      expect([notice.id, reply?.id]).toContain(third.triggerRef);
      expect(chiefRequests().at(-1)?.rawBody).toContain(NOTICE_MARKER);
    },
    JOURNEY_TIMEOUT_MS + 30_000,
  );
});
