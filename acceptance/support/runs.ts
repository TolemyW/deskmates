// Driving one run through the Gateway's public API: post a human message, follow the run to a
// terminal state (SSE for the status sequence, polling as the source of truth), then read the
// ledger, the usage rows and the thread transcript back. Plus the deskbench answer oracle.

import type {
  Run,
  RunEvent,
  RunStatus,
  RunUsage,
  Thread,
  ThreadId,
  ThreadMember,
  ThreadMessage,
} from "@deskmates/contracts";
import { PARKED_RUN_STATUSES, isTerminal } from "@deskmates/contracts";
import { ReadDeadlineError, type TransientReadError, retryTransientRead } from "./retry-read.js";
import type { Stack } from "./start-stack.js";

/**
 * Interval between two reads of a state a helper is waiting for (run status, pending approval,
 * container health). A read is a local HTTP GET or one `docker exec`, so polling this often costs
 * little, and a wait ends within this much of the state changing instead of up to a second later.
 */
export const POLL_MS = 200;

/** What `GET /api/runs/:id` returns: the contracts Run plus the Gateway's bookkeeping columns. */
export interface RunView extends Run {
  createdAt: string;
  config: Record<string, unknown>;
  error?: string;
}

export interface RunStatusEvent {
  type: "run_status";
  threadId?: string;
  run: RunView;
}

let freshThreadSequence = 0;

export interface SseCollector {
  statuses: RunStatusEvent[];
  close(): void;
}

/**
 * Subscribe to `/api/events` and keep every `run_status` frame, in arrival order. With no
 * `threadId` the stream carries every thread's frames, which is what a suite that gives each
 * case its own thread wants: one open stream is also what makes the Gateway count a human as
 * online (`packages/gateway/src/events/presence.ts`), and presence is global, not per thread.
 */
export async function collectRunStatuses(stack: Stack, threadId?: string): Promise<SseCollector> {
  const controller = new AbortController();
  const query = threadId === undefined ? "" : `?threadId=${threadId}`;
  const res = await fetch(`${stack.gatewayUrl}/api/events${query}`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${stack.config.operatorToken}` },
  });
  if (!res.ok) throw new Error(`SSE subscription: HTTP ${res.status}`);
  if (!res.body) throw new Error("no SSE body");
  const statuses: RunStatusEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) {
            const parsed = JSON.parse(data) as { type: string };
            if (parsed.type === "run_status") statuses.push(parsed as RunStatusEvent);
          }
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return { statuses, close: () => controller.abort() };
}

/**
 * A second (third, fourth) chat thread in the stack's workspace, with the stack's bot as its one
 * member. A bot keeps one SDK session per thread (ADR-0005), so a fresh thread is a fresh
 * session: a case that gives its run its own thread cannot have the bot answer from what it did
 * in an earlier case's turn.
 */
export async function newThread(stack: Stack, title: string): Promise<Thread> {
  const res = await stack.api<{ thread: Thread; members: ThreadMember[] }>("POST", "/api/threads", {
    workspaceId: stack.workspace.id,
    botIds: [stack.bot.id],
    title,
    // A plain one-Bot web create now resolves the Bot's canonical private chat. Acceptance cases
    // asking for `newThread` need a genuinely fresh SDK session, so bind a unique test channel
    // identity instead of silently reusing that inbox.
    channel: "web",
    externalKey: `acceptance:${process.pid}:${++freshThreadSequence}:${title}`,
  });
  if (res.status !== 201) {
    throw new Error(`create thread: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.thread;
}

export async function postMessage(
  stack: Stack,
  body: string,
  threadId: ThreadId = stack.thread.id,
): Promise<{ message: ThreadMessage; run: RunView }> {
  const res = await stack.api<{ message: ThreadMessage; runs: RunView[] }>(
    "POST",
    `/api/threads/${threadId}/messages`,
    { body },
  );
  if (res.status !== 201)
    throw new Error(`post message: ${res.status} ${JSON.stringify(res.json)}`);
  const run = res.json.runs[0];
  if (!run) throw new Error("the message created no run");
  return { message: res.json.message, run };
}

export async function getRun(
  stack: Stack,
  runId: string,
  signal?: AbortSignal,
): Promise<{ run: RunView; usage: RunUsage[] }> {
  const res = await stack.api<{ run: RunView; usage: RunUsage[] }>(
    "GET",
    `/api/runs/${runId}`,
    undefined,
    signal ? { signal } : undefined,
  );
  if (res.status !== 200) throw new Error(`get run: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

export interface RunWaitOptions {
  /** Called on every status change the poll observed; the SSE collector sees them all. */
  onStatus?: (status: RunStatus) => void;
  /**
   * Fail the wait as soon as the run parks a *second* time instead of sitting out the timeout.
   * A second park means either the model asked for another L2 action nobody is going to decide,
   * or the resume did not replay the deferred call — both are bugs the case should report at
   * once, naming the run and what is pending, rather than after `RUN_TIMEOUT_MS` of silence.
   *
   * "Second" is decided two ways, because a resume is not instantaneous: a park seen after the
   * run was observed running again, or a park with `attempt` ≥ 2. A park still carrying the
   * first attempt, before any resume was observed, is the park the caller is waiting out.
   */
  failIfParkedAgain?: boolean;
  /** Extra detail for the `failIfParkedAgain` error, e.g. the pending approval id. */
  describeParked?: (run: RunView) => Promise<string> | string;
  /** Records a bounded retry of an idempotent status GET without exposing a stack or URL. */
  onTransientReadError?: (error: TransientReadError) => void;
}

async function parkedAgainError(run: RunView, options: RunWaitOptions): Promise<Error> {
  const detail = (await options.describeParked?.(run)) ?? "";
  return new Error(
    `run ${run.id} parked again (attempt ${run.attempt}, status ${run.status})${
      detail ? `: ${detail}` : ""
    }`,
  );
}

/**
 * Poll until the run is terminal or parked (`waiting_approval` has no process left to wait
 * for).
 */
export async function waitForRun(
  stack: Stack,
  runId: string,
  timeoutMs: number,
  options: RunWaitOptions = {},
): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  let last: RunStatus | undefined;
  let sawRunningAgain = false;
  const transientErrors: TransientReadError[] = [];
  const timeoutError = () => {
    const reasons = transientErrors.length
      ? `; transient read failures: ${transientErrors
          .map((item) => `${item.message}${item.code ? ` (${item.code})` : ""}`)
          .join(", ")}`
      : "";
    return new Error(`run ${runId} still ${last ?? "unknown"} after ${timeoutMs} ms${reasons}`);
  };
  for (;;) {
    let run: RunView;
    try {
      ({ run } = await retryTransientRead((signal) => getRun(stack, runId, signal), {
        deadlineAt: deadline,
        retryDelayMs: 1000,
        onTransientError: (error) => {
          transientErrors.push(error);
          options.onTransientReadError?.(error);
        },
      }));
    } catch (error) {
      if (!(error instanceof ReadDeadlineError)) throw error;
      throw timeoutError();
    }
    if (run.status !== last) {
      last = run.status;
      options.onStatus?.(run.status);
    }
    if (run.status === "waiting_approval") {
      if (options.failIfParkedAgain && (sawRunningAgain || run.attempt >= 2)) {
        throw await parkedAgainError(run, options);
      }
      return run;
    }
    if (isTerminal(run.status)) return run;
    if (!PARKED_RUN_STATUSES.has(run.status)) sawRunningAgain = true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
  }
}

/**
 * Every run of one bot, thread or no thread. `GET /api/runs?botId=` is the only way to see a
 * cron or webhook run: it has no thread, so the thread-scoped list never shows it.
 */
export async function runsForBot(stack: Stack, botId: string = stack.bot.id): Promise<RunView[]> {
  return allRuns(stack, `botId=${botId}`);
}

/**
 * Every run in a run-list scope, oldest first. The list is a newest-first keyset page (#113
 * slice R), so this follows `nextCursor` to the end.
 */
export async function allRuns(stack: Stack, scope: string): Promise<RunView[]> {
  const runs: RunView[] = [];
  let cursor: string | undefined;
  do {
    const res = await stack.api<{ runs: RunView[]; nextCursor?: string }>(
      "GET",
      `/api/runs?${scope}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (res.status !== 200) throw new Error(`list runs: ${res.status} ${JSON.stringify(res.json)}`);
    runs.push(...res.json.runs);
    cursor = res.json.nextCursor;
  } while (cursor);
  return runs.reverse();
}

/** Every event of a run in `seq` order, read as bounded tails (#113 slice R). */
export async function runEvents(stack: Stack, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let more = true;
  while (more) {
    const res = await stack.api<{ events: RunEvent[]; hasMore?: boolean }>(
      "GET",
      `/api/runs/${runId}/events?afterSeq=${events.at(-1)?.seq ?? 0}`,
    );
    if (res.status !== 200) throw new Error(`get events: ${res.status}`);
    events.push(...res.json.events);
    more = res.json.hasMore === true && res.json.events.length > 0;
  }
  return events;
}

export async function threadMessages(
  stack: Stack,
  threadId: ThreadId = stack.thread.id,
): Promise<ThreadMessage[]> {
  return allMessages(stack, threadId);
}

/** A whole transcript in `seq` order, read as bounded tails (#113 slice CH). */
export async function allMessages(stack: Stack, threadId: string): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  for (let more = true; more; ) {
    const res = await stack.api<{ messages: ThreadMessage[]; hasMore?: boolean }>(
      "GET",
      `/api/threads/${threadId}/messages?afterSeq=${messages.at(-1)?.seq ?? 0}`,
    );
    if (res.status !== 200) throw new Error(`get messages: ${res.status}`);
    messages.push(...res.json.messages);
    more = res.json.hasMore === true && res.json.messages.length > 0;
  }
  return messages;
}

/** The bot's reply that a run posted, if any. */
export function replyOf(messages: readonly ThreadMessage[], runId: string): string | undefined {
  return messages.find((m) => m.authorKind === "bot" && m.runId === runId)?.body;
}

/** Bare tool name of a `tool_call` event (`mcp__browser__browser_navigate` -> `browser_navigate`). */
export function toolNameOf(event: RunEvent): string {
  const raw = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  const m = /^mcp__.+?__(.+)$/.exec(raw);
  return m?.[1] ?? raw;
}

export function toolCalls(events: readonly RunEvent[], tool: string): RunEvent[] {
  return events.filter((e) => e.kind === "tool_call" && toolNameOf(e) === tool);
}

/** Benchmark §5: the answer is the last `answer: <value>` line of the final reply. */
export function answerOf(reply: string | undefined): string | undefined {
  if (reply === undefined) return undefined;
  let found: string | undefined;
  for (const m of reply.matchAll(/^\s*answer:\s*(.+?)\s*$/gim)) found = m[1];
  return found?.replace(/^[`*_]+|[`*_]+$/g, "").trim();
}

/** Benchmark §5 normalisation: thousands separators dropped, decimals unified, whitespace trimmed. */
export function normaliseAnswer(value: string): string {
  const v = value.trim().replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
  return v.toLowerCase();
}

export function describeStatuses(collected: readonly RunStatusEvent[], runId: string): RunStatus[] {
  const out: RunStatus[] = [];
  for (const s of collected) {
    if (s.run.id !== runId) continue;
    if (out[out.length - 1] !== s.run.status) out.push(s.run.status);
  }
  return out;
}
