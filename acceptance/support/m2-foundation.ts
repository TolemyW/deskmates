// The M2 foundation protocol as the live-model suites share it: the test SOUL every bot reads,
// the three-bot fixture, the settle loop, the chief delegation check and the evidence it is
// assessed on. `m2-group-foundation.acceptance.test.ts` and `m2-model-ab.acceptance.test.ts`
// both import it, so the two arms of a model A/B and the existing suite cannot drift apart.

import {
  type BotDefinition,
  type BrowserSnapshotMode,
  type Thread,
  type ThreadId,
  isTerminal,
} from "@deskmates/contracts";
import { expect } from "vitest";
import { type M2Assessment, assessFoundationCase } from "./m2-assessment.js";
import { type GroupTarget, createGroupBot, createGroupThread } from "./m2-group.js";
import type { Stack } from "./start-stack.js";

export const FOUNDATION_MAX_TURNS = 8;
export const FOUNDATION_RUN_TIMEOUT_SECONDS = 180;
export const FOUNDATION_SETTLE_TIMEOUT_MS = 6 * 60_000;

/** The run knobs the foundation probe sets on its Gateway before any case is scheduled. */
export function applyFoundationRunConfig(stack: Stack, snapshotMode: BrowserSnapshotMode): void {
  stack.config.browserSnapshotMode = snapshotMode;
  stack.config.maxTurns = FOUNDATION_MAX_TURNS;
  stack.config.runTimeoutSeconds = FOUNDATION_RUN_TIMEOUT_SECONDS;
}

export function foundationSoul(
  name: string,
  role: string,
  chief: string,
  analyst: string,
  reviewer: string,
): string {
  return `# ${name}
You are ${name}, the ${role}, in a controlled group-routing integration test.
Follow these test rules and the human's request. Do not browse, read files, use shell,
write memory, or call tools other than the messaging tools needed by the cases below.
Return ONLY the required fenced JSON summary, without prose outside it.
An empty reply is intentional silence; put internal reasoning only in done.

- CHIEF human request: chief must call thread_post once, addressing both ${analyst}
  and ${reviewer}, with CHIEF_ASSIGN and the marker: analyst computes 17+25,
  reviewer computes 9*6. Then end this run immediately with an empty reply; do not
  wait inside the run. Do not compute the experts' answers yourself.
- CHIEF_ASSIGN from the chief: analyst replies "@${chief} A_RESULT:42" plus the
  marker; reviewer replies "@${chief} R_RESULT:54" plus the marker. This SOUL
  authorizes these roles to handle the assignment from the chief. Answer once only.
- Chief seeing expert results: if both A_RESULT and R_RESULT are present anywhere
  in the conversation/session, add them and reply CHIEF_TOTAL:96 plus the marker.
  If only one result has arrived, end silently and wait for another wake.
  Never repeat the initial delegation or the completed total for the same marker.
- ORDERED human request: only the chief replies with ORDERED_OK and the case marker.
  All other roles remain silent, even if they see the original human request.
- PARALLEL human request: only the explicitly named analyst and reviewer reply.
  Analyst replies ANALYST_OK and the marker; reviewer replies REVIEWER_OK and the marker.
- DIRECT human request, chief in a chat: call message_bot exactly once to ${analyst},
  body "DIRECT_REQUEST: compute 12+7 and reply to @${chief}" plus the case marker.
  Then finish with reply HANDOFF_SENT plus the marker. Do not use thread_post.
- In a bus conversation, analyst receiving DIRECT_REQUEST replies exactly
  "@${chief} DIRECT_RESULT:19" plus the marker. This is authorized by this SOUL.
- In a bus conversation, chief receiving DIRECT_RESULT stays silent.
- If only bot/system messages are newly delivered and no rule above applies,
  stay silent. Never acknowledge completed work or wake peers just to thank them.
`;
}

export interface FoundationNames {
  chief: string;
  analyst: string;
  reviewer: string;
}

export interface FoundationFixture {
  names: FoundationNames;
  /** Chief, analyst, reviewer, in that order. */
  bots: BotDefinition[];
  /** A thread in the fixture's workspace with the given members, titled with the case label. */
  create(members: readonly BotDefinition[]): Promise<Thread>;
}

/** Per-bot model overrides; unset keeps the Gateway's DEFAULT_MODEL / CHEAP_MODEL. */
export interface FoundationBotModels {
  model?: string;
  cheapModel?: string;
}

/** Chief, analyst and reviewer named after `label`, in `target` (the stack's own workspace by default). */
export async function createFoundationBots(
  stack: Stack,
  label: string,
  target?: GroupTarget,
  models: FoundationBotModels = {},
): Promise<FoundationFixture> {
  const names: FoundationNames = {
    chief: `chief_${label}`,
    analyst: `analyst_${label}`,
    reviewer: `reviewer_${label}`,
  };
  const bots: BotDefinition[] = [];
  for (const role of ["chief", "analyst", "reviewer"] as const) {
    bots.push(
      await createGroupBot(
        stack,
        {
          name: names[role],
          role,
          soul: foundationSoul(names[role], role, names.chief, names.analyst, names.reviewer),
          messageAllowlist: role === "chief" ? [names.analyst] : [],
          ...models,
        },
        target,
      ),
    );
  }
  return {
    names,
    bots,
    create: (members) => createGroupThread(stack, members, label, target),
  };
}

type RunRecord = ReturnType<Stack["app"]["deskmates"]["ctx"]["runs"]["list"]>[number];

/** Wait until every run of `botIds` is terminal, nothing is pending, and the group stayed quiet. */
export async function settleFoundationGroup(
  stack: Stack,
  botIds: Set<string>,
  minimumRuns: number,
  logPrefix = "[m2-live]",
): Promise<RunRecord[]> {
  const ctx = stack.app.deskmates.ctx;
  const deadline = Date.now() + FOUNDATION_SETTLE_TIMEOUT_MS;
  let stableSince = 0;
  let previous = "";
  while (Date.now() < deadline) {
    const runs = ctx.runs.list().filter((r) => botIds.has(r.botId));
    const state = runs.map((r) => `${ctx.bots.mustGet(r.botId).name}:${r.status}`).join(",");
    if (state !== previous) {
      console.log(`${logPrefix} ${state}`);
      previous = state;
    }
    const failed = runs.find((r) => r.status === "failed");
    if (failed) throw new Error(`run ${failed.id} failed: ${failed.error}`);
    const parked = runs.find(
      (r) => r.status === "waiting_approval" || r.status === "waiting_browser",
    );
    if (parked) throw new Error(`unexpected parked run ${parked.id}: ${parked.status}`);
    const pending = ctx.walks
      .pendingThreadIds()
      .some((id) => ctx.threads.members(id).some((m) => botIds.has(m.botId)));
    if (runs.length > 0 && runs.every((r) => isTerminal(r.status)) && !pending) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 1500) {
        if (runs.length < minimumRuns)
          throw new Error(`only ${runs.length} runs; expected at least ${minimumRuns}`);
        return runs;
      }
    } else stableSince = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`group did not settle: ${previous}`);
}

/** The chief delegation case: the chief assigns 17+25 and 9*6, the experts answer, the chief adds. */
export async function checkChiefDelegation(
  stack: Stack,
  fixture: FoundationFixture,
  round: number,
  logPrefix?: string,
): Promise<void> {
  const { names, bots, create } = fixture;
  const thread = await create(bots);
  await stack.api("POST", `/api/threads/${thread.id}/messages`, {
    body: `@${names.chief} CHIEF case marker chief${round}: delegate 17+25 to ${names.analyst} and 9*6 to ${names.reviewer}. End your run after delegating, then combine the experts' results after they respond.`,
  });
  const runs = await settleFoundationGroup(stack, new Set(bots.map((b) => b.id)), 4, logPrefix);
  expect(runs.every((r) => r.status === "succeeded" || r.status === "silent")).toBe(true);
  const ctx = stack.app.deskmates.ctx;
  const messages = ctx.messages.list(thread.id);
  // Two separate facts. Fused as one `expect(assignment?.mentions…).toHaveLength(2)` they
  // failed as chai's "Target cannot be null or undefined", which says neither which fact
  // broke nor what the chief actually posted; the 2026-09-25 soak needed the retained
  // transcript to find out.
  const assignment = messages.find(
    (m) => m.authorId === bots[0]?.id && m.body.includes("CHIEF_ASSIGN"),
  );
  const chiefPosts = messages
    .filter((m) => m.authorId === bots[0]?.id)
    .map((m) => m.body.slice(0, 120));
  expect(
    assignment,
    `chief posted no CHIEF_ASSIGN message; it posted ${JSON.stringify(chiefPosts)}`,
  ).toBeDefined();
  expect(
    assignment?.mentions.filter((m) => m.kind === "bot"),
    `the CHIEF_ASSIGN message must mention both experts: ${JSON.stringify(assignment?.body)}`,
  ).toHaveLength(2);
  const a = messages.find((m) => m.authorId === bots[1]?.id && m.body.includes("A_RESULT:42"));
  const r = messages.find((m) => m.authorId === bots[2]?.id && m.body.includes("R_RESULT:54"));
  const total = messages.find(
    (m) => m.authorId === bots[0]?.id && m.body.includes("CHIEF_TOTAL:96"),
  );
  expect(a).toBeDefined();
  expect(r).toBeDefined();
  expect(total).toBeDefined();
  expect(total?.seq).toBeGreaterThan(
    Math.max(a?.seq ?? Number.POSITIVE_INFINITY, r?.seq ?? Number.POSITIVE_INFINITY),
  );
  const chiefRuns = runs.filter((run) => run.botId === bots[0]?.id);
  expect(chiefRuns.length).toBeGreaterThanOrEqual(2);
  expect(
    chiefRuns.some((run) =>
      ctx.events
        .list(run.id)
        .some((e) => e.kind === "tool_call" && JSON.stringify(e.payload).includes("thread_post")),
    ),
  ).toBe(true);
  expect(ctx.threads.mustGet(thread.id).status).toBe("active");
}

export interface FoundationEvidence {
  runs: RunRecord[];
  threadIds: ThreadId[];
  /** Absent when the fixture did not get as far as three bots. */
  assessment: M2Assessment | undefined;
}

/** Every run and thread of `bots`, and the three-dimension assessment of case `label` on them. */
export function collectFoundationEvidence(
  stack: Stack,
  label: string,
  bots: readonly BotDefinition[],
): FoundationEvidence {
  const ctx = stack.app.deskmates.ctx;
  const ids = new Set(bots.map((b) => b.id));
  const runs = ctx.runs.list().filter((r) => ids.has(r.botId));
  const threadIds = [...new Set(runs.flatMap((r) => (r.threadId ? [r.threadId] : [])))];
  const messages = threadIds.flatMap((id) => ctx.messages.list(id));
  const assessment =
    bots.length === 3
      ? assessFoundationCase({
          label,
          chiefId: bots[0]?.id ?? "",
          analystId: bots[1]?.id ?? "",
          reviewerId: bots[2]?.id ?? "",
          messages,
          runs: runs.map((run) => ({
            id: run.id,
            botId: run.botId,
            status: run.status,
            events: ctx.events.list(run.id),
            lane: run.lane,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          })),
          evidenceComplete: runs.length > 0 && runs.every((run) => isTerminal(run.status)),
        })
      : undefined;
  return { runs, threadIds, assessment };
}
