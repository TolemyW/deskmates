import { mkdirSync } from "node:fs";
import type {
  BotDefinition,
  RunEvent,
  SandboxHandle,
  Thread,
  ThreadMember,
  ThreadMessage,
  Workspace,
} from "@deskmates/contracts";
import { botHomeDir, isTerminal } from "@deskmates/contracts";
import { setCanonicalSoul } from "./canonical-soul.js";
import { POLL_MS, type RunView, allMessages, allRuns, runEvents } from "./runs.js";
import type { Stack } from "./start-stack.js";

export const GROUP_RUN_TIMEOUT_MS = 6 * 60_000;

export interface GroupBotSpec {
  name: string;
  role: string;
  soul: string;
  /** Per-bot model override; unset means the Gateway's DEFAULT_MODEL. */
  model?: string;
  /** Per-bot cheap model override; unset means the Gateway's CHEAP_MODEL. */
  cheapModel?: string;
  /** Bots this one may reach with `message_bot`; unset means the Gateway's default (none). */
  messageAllowlist?: readonly string[];
}

/**
 * The workspace a helper acts on and the container that backs it. Omitted, it is the stack's own
 * pair; a second workspace from `addWorkspace` passes its own, which is how one Gateway hosts two
 * groups of bots side by side.
 */
export interface GroupTarget {
  workspace: Workspace;
  handle: SandboxHandle;
}

function ownTarget(stack: Stack): GroupTarget {
  return { workspace: stack.workspace, handle: stack.handle };
}

export async function createGroupBot(
  stack: Stack,
  spec: GroupBotSpec,
  target: GroupTarget = ownTarget(stack),
): Promise<BotDefinition> {
  const response = await stack.api<{
    bot: BotDefinition;
    welcomeRun: { id: string };
  }>("POST", "/api/bots", {
    name: spec.name,
    role: spec.role,
    workspaceId: target.workspace.id,
    // Only when set: an absent key is what makes the Gateway fall back to its defaults.
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.cheapModel === undefined ? {} : { cheapModel: spec.cheapModel }),
    ...(spec.messageAllowlist === undefined ? {} : { messageAllowlist: spec.messageAllowlist }),
  });
  if (response.status !== 201) {
    throw new Error(`create bot ${spec.name}: ${response.status} ${JSON.stringify(response.json)}`);
  }
  // Group scenarios provide exact scripted model turns. The product welcome lifecycle has its
  // own tests; cancel it here before it can occupy the lane or consume the first scripted turn.
  // T0 request-shape tests use a deliberately partial Stack without a live Gateway. A real T2
  // stack always has both the welcome receipt and scheduler, and cancels/drains it here.
  const scheduler = stack.app?.deskmates?.scheduler;
  if (response.json.welcomeRun && scheduler) {
    scheduler.cancel(response.json.welcomeRun.id as import("@deskmates/contracts").RunId, "test");
    await scheduler.drain();
  }
  const soulPath = `${botHomeDir(spec.name)}/SOUL.md`;
  const wrote = await stack.provider.exec(target.handle, {
    cmd: ["/bin/sh", "-c", 'mkdir -p "$(dirname "$0")" && cat > "$0"', soulPath],
    stdin: spec.soul,
    timeoutMs: 15_000,
  });
  if (wrote.exitCode !== 0) throw new Error(`write ${soulPath}: ${wrote.stderr}`);
  await setCanonicalSoul(stack.api, response.json.bot.id, spec.soul, spec.name);
  return response.json.bot;
}

export async function createGroupThread(
  stack: Stack,
  bots: readonly BotDefinition[],
  title: string,
  target: GroupTarget = ownTarget(stack),
): Promise<Thread> {
  const response = await stack.api<{ thread: Thread }>("POST", "/api/threads", {
    workspaceId: target.workspace.id,
    botIds: bots.map((bot) => bot.id),
    title,
  });
  if (response.status !== 201) {
    throw new Error(`create thread: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json.thread;
}

export async function postGroupMessage(
  stack: Stack,
  thread: Thread,
  body: string,
  options: { roundMode?: "parallel" | "sequential" } = {},
): Promise<{ message: ThreadMessage; runs: RunView[] }> {
  const response = await stack.api<{ message: ThreadMessage; runs: RunView[] }>(
    "POST",
    `/api/threads/${thread.id}/messages`,
    // ADR-0005 amendment 4, decision 29: one-by-one is asked per message; parallel sends nothing.
    { body, ...(options.roundMode === "sequential" ? { roundMode: "sequential" } : {}) },
  );
  if (response.status !== 201) {
    throw new Error(`post message: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

export async function threadRuns(stack: Stack, thread: Thread): Promise<RunView[]> {
  return allRuns(stack, `threadId=${thread.id}`);
}

export async function groupMessages(stack: Stack, thread: Thread): Promise<ThreadMessage[]> {
  return allMessages(stack, thread.id);
}

export async function groupMembers(stack: Stack, thread: Thread): Promise<ThreadMember[]> {
  const response = await stack.api<{ members: ThreadMember[] }>("GET", `/api/threads/${thread.id}`);
  if (response.status !== 200) throw new Error(`get thread: ${response.status}`);
  return response.json.members;
}

export async function groupRunEvents(stack: Stack, run: RunView): Promise<RunEvent[]> {
  return runEvents(stack, run.id);
}

/** Wait for the expected run count and a quiet terminal window, preserving late coalesced wakes. */
export async function waitForGroup(
  stack: Stack,
  thread: Thread,
  minimumRuns: number,
  timeoutMs = GROUP_RUN_TIMEOUT_MS,
): Promise<RunView[]> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let signature = "";
  for (;;) {
    const runs = await threadRuns(stack, thread);
    const next = runs.map((run) => `${run.id}:${run.status}:${run.attempt}`).join(",");
    if (next !== signature) {
      signature = next;
      stableSince = 0;
    }
    const failed = runs.find((run) => run.status === "failed");
    if (failed) throw new Error(`run ${failed.id} failed: ${failed.error ?? "unknown error"}`);
    const parked = runs.find(
      (run) => run.status === "waiting_approval" || run.status === "waiting_browser",
    );
    if (parked) throw new Error(`run ${parked.id} unexpectedly parked as ${parked.status}`);
    if (runs.length >= minimumRuns && runs.every((run) => isTerminal(run.status))) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 2_000) return runs;
    }
    if (Date.now() > deadline) {
      throw new Error(`group did not settle with ${minimumRuns} runs: ${signature}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function browserTabIds(events: readonly RunEvent[]): string[] {
  return [
    ...new Set(
      events
        .filter((event) => event.payload.source === "browser_lock")
        .map((event) => event.payload.tabId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
}

export function ensureReportDir(path: string | undefined): string | undefined {
  if (!path) return undefined;
  mkdirSync(path, { recursive: true });
  return path;
}
