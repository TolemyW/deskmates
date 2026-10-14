// T3 foundation probe: real Gateway, Docker workspace, sidecar, SDK and configured model.
// No shared browser actions: runtime tab propagation remains the separate B2 gate.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BotDefinition,
  THREAD_LINK_ATTACHMENT_MIME,
  type ThreadId,
} from "@deskmates/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  applyFoundationRunConfig,
  checkChiefDelegation,
  collectFoundationEvidence,
  createFoundationBots,
  settleFoundationGroup,
} from "./support/m2-foundation.js";
import { type Stack, groupRoutingOf, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const image = process.env.WORKSPACE_IMAGE ?? "";
const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const reports: Record<string, unknown>[] = [];
const output = process.env.M2_REPORT_DIR;
const repetitions = Number(process.env.M2_REPETITIONS ?? 2);
const snapshotMode = selectM2BrowserSnapshotMode(process.env.M2_BROWSER_SNAPSHOT_MODE);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
  throw new Error("M2_REPETITIONS must be between 1 and 5");
let stack: Stack | undefined;

async function fixture(label: string) {
  const s = stack as Stack;
  return { s, ...(await createFoundationBots(s, label)) };
}

async function settle(botIds: Set<string>, minimumRuns: number) {
  return settleFoundationGroup(stack as Stack, botIds, minimumRuns);
}

async function record(
  label: string,
  bots: readonly BotDefinition[],
  start: number,
  error?: unknown,
) {
  const s = stack as Stack;
  const ctx = s.app.deskmates.ctx;
  const { runs, threadIds, assessment } = collectFoundationEvidence(s, label, bots);
  const row = {
    label,
    passed: error === undefined,
    ...(assessment ? { assessment } : {}),
    wallMs: Date.now() - start,
    ...(error === undefined ? {} : { error: String(error) }),
    model: modelEnv().defaultModel,
    image,
    runs: runs.map((r) => ({
      id: r.id,
      bot: ctx.bots.mustGet(r.botId).name,
      threadId: r.threadId,
      lane: r.lane,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      reply: r.summary?.reply,
      usage: ctx.usage.list(r.id),
      config: r.config,
      events: ctx.events.list(r.id),
      delivery: s.provider.sidecarRuns().find((entry) => entry.request.runId === r.id)?.request
        .trigger,
    })),
    threads: threadIds.map((id) => ({
      thread: ctx.threads.mustGet(id),
      messages: ctx.messages.list(id),
    })),
  };
  reports.push(row);
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "results.json"), JSON.stringify(reports, null, 2));
  }
  console.log(
    `[m2-live] ${label}: ${row.passed ? "PASS" : "FAIL"}, ${row.wallMs}ms, ${runs.length} runs`,
  );
}

async function execute(
  label: string,
  test: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture(label);
  const started = Date.now();
  let failure: unknown;
  try {
    await test(f);
  } catch (error) {
    failure = error;
  }
  await record(label, f.bots, started, failure);
  if (failure) throw failure;
}

describe.sequential("M2 foundation with the configured real model", () => {
  beforeAll(async () => {
    if (missing.length || !dockerUp)
      throw new Error(
        `missing model variables: ${missing.join(",")}; Docker reachable: ${dockerUp}`,
      );
    requireWorkspaceImageId();
  }, 120_000);

  beforeEach(async () => {
    stack = await startStack({ ...modelEnv(), label: "m2-live", botName: "bootstrap" });
    applyFoundationRunConfig(stack, snapshotMode);
    console.log(
      `[m2-live] isolated container ${stack.handle.providerRef}; gateway ${stack.gatewayUrl}`,
    );
  }, 120_000);

  afterEach(async () => {
    await stopStack(stack);
    stack = undefined;
  }, 120_000);

  for (let round = 1; round <= repetitions; round++) {
    it(
      `round ${round}: chief delegates to two experts and combines their results`,
      async () => {
        await execute(`chief${round}`, (f) => checkChiefDelegation(f.s, f, round));
      },
      8 * 60_000,
    );

    it(
      `round ${round}: ordered group delivery and intentional silence`,
      async () => {
        await execute(`ordered${round}`, async ({ s, bots, create }) => {
          const thread = await create(bots);
          const response = await s.api("POST", `/api/threads/${thread.id}/messages`, {
            body: `ORDERED case marker ordered${round}: follow your role's test rule.`,
          });
          expect(response.status).toBe(201);
          // Decision 4 walks all three members; under owner-v1 (amendment 2) the offer ends
          // with the chief's answer and the two others are never woken for it.
          const offered = groupRoutingOf(s) === "owner-v1";
          const runs = await settle(new Set(bots.map((b) => b.id)), offered ? 1 : 3);
          expect(runs.map((r) => r.botId)).toEqual(offered ? [bots[0]?.id] : bots.map((b) => b.id));
          expect(["succeeded", "silent"]).toContain(runs[0]?.status);
          expect(runs.slice(1).map((r) => r.status)).toEqual(offered ? [] : ["silent", "silent"]);
          if (offered)
            expect(s.app.deskmates.ctx.threads.mustGet(thread.id).ownerBotId).toBe(bots[0]?.id);
          // A bot may post its answer through thread_post and end with an empty final reply.
          // The transcript, not the terminal status alone, proves which member answered.
          const replies = s.app.deskmates.ctx.messages
            .list(thread.id)
            .filter((m) => m.authorKind === "bot");
          expect(replies).toHaveLength(1);
          expect(replies[0]?.authorId).toBe(bots[0]?.id);
          expect(replies[0]?.body).toContain("ORDERED_OK");
          for (let i = 1; i < runs.length; i++)
            expect(Date.parse(runs[i]?.startedAt ?? "")).toBeGreaterThanOrEqual(
              Date.parse(runs[i - 1]?.finishedAt ?? ""),
            );
          const requests = s.provider.sidecarRuns().map((entry) => entry.request);
          for (const bot of offered ? [] : bots.slice(1))
            expect(
              requests.some(
                (r) =>
                  r.botId === bot.id &&
                  r.trigger.kind === "thread_message" &&
                  r.trigger.messages.some((m) => m.body.includes("ORDERED_OK")),
              ),
            ).toBe(true);
        });
      },
      8 * 60_000,
    );

    it(
      `round ${round}: explicitly mentioned peers start concurrently`,
      async () => {
        await execute(`parallel${round}`, async ({ s, names, bots, create }) => {
          const peers = bots.slice(1);
          const thread = await create(peers);
          await s.api("POST", `/api/threads/${thread.id}/messages`, {
            body: `@${names.analyst} @${names.reviewer} PARALLEL case marker parallel${round}: follow your role's test rule.`,
          });
          const runs = await settle(new Set(bots.map((b) => b.id)), 2);
          expect(runs.every((r) => r.status === "succeeded" || r.status === "silent")).toBe(true);
          const first = peers.map((b) => runs.find((r) => r.botId === b.id));
          expect(Math.max(...first.map((r) => Date.parse(r?.startedAt ?? "")))).toBeLessThan(
            Math.min(...first.map((r) => Date.parse(r?.finishedAt ?? ""))),
          );
          const replies = s.app.deskmates.ctx.messages
            .list(thread.id)
            .filter((m) => m.authorKind === "bot");
          expect(replies).toHaveLength(2);
          expect(replies.some((m) => m.body.includes("ANALYST_OK"))).toBe(true);
          expect(replies.some((m) => m.body.includes("REVIEWER_OK"))).toBe(true);
        });
      },
      8 * 60_000,
    );

    it(
      `round ${round}: real message_bot tool hands off to a background bus`,
      async () => {
        await execute(`direct${round}`, async ({ s, bots, create }) => {
          const chief = bots[0] as BotDefinition;
          const analyst = bots[1] as BotDefinition;
          const thread = await create([chief]);
          await s.api("POST", `/api/threads/${thread.id}/messages`, {
            body: `DIRECT case marker direct${round}: use message_bot to ask your configured analyst to compute 12+7 and report back.`,
          });
          const runs = await settle(new Set(bots.map((b) => b.id)), 3);
          expect(runs.every((r) => r.status === "succeeded" || r.status === "silent")).toBe(true);
          const ctx = s.app.deskmates.ctx;
          const notice = ctx.messages
            .list(thread.id)
            .find((m) => m.attachments.some((a) => a.mimeType === THREAD_LINK_ATTACHMENT_MIME));
          expect(notice).toBeDefined();
          const busId = notice?.attachments.find((a) => a.mimeType === THREAD_LINK_ATTACHMENT_MIME)
            ?.ref as ThreadId;
          expect(ctx.threads.mustGet(busId).kind).toBe("bus");
          expect(
            ctx.messages
              .list(busId)
              .some((m) => m.authorId === analyst.id && m.body.includes("DIRECT_RESULT:19")),
          ).toBe(true);
          expect(
            runs.some(
              (r) => r.botId === analyst.id && r.threadId === busId && r.lane === "background",
            ),
          ).toBe(true);
          expect(
            runs.some((r) => r.botId === chief.id && r.threadId === busId && r.status === "silent"),
          ).toBe(true);
          expect(
            runs
              .flatMap((r) => ctx.events.list(r.id))
              .some(
                (e) => e.kind === "tool_call" && JSON.stringify(e.payload).includes("message_bot"),
              ),
          ).toBe(true);
        });
      },
      8 * 60_000,
    );
  }
});
