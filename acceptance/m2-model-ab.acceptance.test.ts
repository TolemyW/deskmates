// T3 paired model A/B: one Gateway, two workspaces, the chief delegation case N times per arm.
//
// Arm A's three bots (chief, analyst, reviewer) live in the stack's own workspace, arm B's in a
// second workspace from `addWorkspace`; every bot of an arm is pinned to that arm's model
// (`model` and `cheapModel` both), read from M2_AB_MODEL_A and M2_AB_MODEL_B. Rounds come from
// M2_AB_ROUNDS (default 5). With neither model id set the suite is skipped, so a full T3 run
// without an A/B campaign still passes; with only one set it fails, never falling back to
// DEFAULT_MODEL. The SOUL, fixture, settle loop, pass criteria and assessment are the
// foundation suite's own (`support/m2-foundation.ts`), and both arms use the same bot names and
// case marker in their own workspace, so the two arms see the same text and differ only in the
// model. Rounds interleave, never overlap: round i of A, then round i of B, then round i+1.
// Both containers stay up for the whole campaign.
//
// What this harness can answer: whether, under the same host conditions in the same time window,
// one model fails this scenario far more often than the other, and how their wall time and token
// counts compare on it. What it cannot answer: with N rounds per arm the comparison only resolves
// large differences. To distinguish a 10% failure rate from a 30% one at conventional confidence
// needs roughly 20+ rounds per arm. A 5-round campaign can detect "one model cannot do this at
// all"; it cannot rank two models that both mostly work. It is one scenario, not deskbench, and
// not a strategy verdict (measurement doc section 4.4). The summary prints this caveat with the
// numbers so a bare pass count is not read as a ranking.
//
// Output (M2_REPORT_DIR): results.json, one row per (arm, round) with the arm, model, passed,
// wallMs, the three assessment dimensions and per-run input/output/cache-read/cache-create tokens,
// `unknown` where the ledger holds no usage; summary.json, per arm pass count, median and range
// of wallMs, total tokens, and the caveat.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotDefinition } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, requireWorkspaceImageId } from "./support/docker.js";
import { missingModelEnv, modelEnv } from "./support/env.js";
import { selectM2BrowserSnapshotMode } from "./support/m2-browser-snapshot-mode.js";
import {
  type FoundationFixture,
  applyFoundationRunConfig,
  checkChiefDelegation,
  collectFoundationEvidence,
  createFoundationBots,
} from "./support/m2-foundation.js";
import type { GroupTarget } from "./support/m2-group.js";
import {
  AB_ARMS,
  type AbArm,
  type AbConfig,
  type AbRow,
  formatAbSummary,
  readAbConfig,
  runTokens,
  sumTokens,
  summarizeAbRows,
} from "./support/m2-model-ab.mjs";
import { type Stack, addWorkspace, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const image = process.env.WORKSPACE_IMAGE ?? "";
const missing = missingModelEnv();
const dockerUp = await dockerAvailable();
const output = process.env.M2_REPORT_DIR;
// Always explicit-v1, the foundation default: the snapshot mode is not a knob of this experiment.
const snapshotMode = selectM2BrowserSnapshotMode(undefined);

// Read at collection time so the round count shapes the test list; a missing model id is
// reported by beforeAll as the reason every case fails, never replaced by DEFAULT_MODEL.
let config: AbConfig | undefined;
let configError: unknown;
try {
  config = readAbConfig(process.env);
} catch (error) {
  configError = error;
}
const rounds = config?.rounds ?? 1;
// Neither id set means "no A/B campaign requested", not a misconfigured one.
const noCampaign =
  !(process.env.M2_AB_MODEL_A ?? "").trim() && !(process.env.M2_AB_MODEL_B ?? "").trim();

let stack: Stack | undefined;
const targets = new Map<AbArm, GroupTarget>();
const rows: AbRow[] = [];

function armModel(arm: AbArm): string {
  const c = config as AbConfig;
  return arm === "A" ? c.modelA : c.modelB;
}

function writeReports(): ReturnType<typeof summarizeAbRows> | undefined {
  if (!config) return undefined;
  const summary = summarizeAbRows(rows, { A: config.modelA, B: config.modelB }, config.rounds);
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "results.json"), JSON.stringify(rows, null, 2));
    writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  }
  return summary;
}

function record(
  arm: AbArm,
  round: number,
  label: string,
  bots: readonly BotDefinition[],
  start: number,
  error?: unknown,
): void {
  const s = stack as Stack;
  const ctx = s.app.deskmates.ctx;
  const { runs, threadIds, assessment } = collectFoundationEvidence(s, label, bots);
  const runRows = runs.map((r) => {
    const usage = ctx.usage.list(r.id);
    return {
      id: r.id,
      bot: ctx.bots.mustGet(r.botId).name,
      threadId: r.threadId,
      lane: r.lane,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      reply: r.summary?.reply,
      model: r.config.model,
      cheapModel: r.config.cheapModel,
      tokens: runTokens(usage),
      usage,
      config: r.config,
      events: ctx.events.list(r.id),
    };
  });
  const row: AbRow = {
    arm,
    model: armModel(arm),
    round,
    label,
    passed: error === undefined,
    wallMs: Date.now() - start,
    assessment,
    tokens: sumTokens(runRows.map((run) => run.tokens)),
    runs: runRows,
    ...(error === undefined ? {} : { error: String(error) }),
    workspaceId: targets.get(arm)?.workspace.id,
    image,
    threads: threadIds.map((id) => ({
      thread: ctx.threads.mustGet(id),
      messages: ctx.messages.list(id),
    })),
  };
  rows.push(row);
  writeReports();
  console.log(
    `[m2-ab] ${arm} ${row.model} round ${round}: ${row.passed ? "PASS" : "FAIL"}, ${row.wallMs}ms, ${runs.length} runs`,
  );
}

async function executeArm(arm: AbArm, round: number): Promise<void> {
  const s = stack as Stack;
  const target = targets.get(arm);
  if (!target) throw new Error(`arm ${arm} has no workspace`);
  const model = armModel(arm);
  const label = `chief${round}`;
  let fixture: FoundationFixture | undefined;
  let started = Date.now();
  let failure: unknown;
  try {
    fixture = await createFoundationBots(s, label, target, { model, cheapModel: model });
    started = Date.now();
    await checkChiefDelegation(s, fixture, round, `[m2-ab ${arm}]`);
    // The comparison is void if a run did not run on its arm's model.
    const ids = new Set(fixture.bots.map((bot) => bot.id));
    const offModel = s.app.deskmates.ctx.runs
      .list()
      .filter((run) => ids.has(run.botId) && run.config.model !== model);
    expect(
      offModel.map((run) => `${run.id}:${String(run.config.model)}`),
      `runs not on arm ${arm}'s model ${model}`,
    ).toEqual([]);
  } catch (error) {
    failure = fixture ? error : new Error(`fixture: ${String(error)}`);
  }
  record(arm, round, label, fixture?.bots ?? [], started, failure);
  if (failure) throw failure;
}

describe.skipIf(noCampaign).sequential("M2 paired model A/B on the chief delegation case", () => {
  beforeAll(async () => {
    if (configError) throw configError;
    if (missing.length || !dockerUp)
      throw new Error(
        `missing model variables: ${missing.join(",")}; Docker reachable: ${dockerUp}`,
      );
    requireWorkspaceImageId();
    stack = await startStack({ ...modelEnv(), label: "m2-ab", botName: "bootstrap" });
    applyFoundationRunConfig(stack, snapshotMode);
    targets.set("A", { workspace: stack.workspace, handle: stack.handle });
    const siteHost = new URL(stack.siteOriginForBot).hostname;
    const b = await addWorkspace(stack, { label: "m2-ab-b", egressAllowlist: [siteHost] });
    targets.set("B", { workspace: b.workspace, handle: b.handle });
    console.log(
      `[m2-ab] A ${armModel("A")} in ${stack.handle.providerRef}; B ${armModel("B")} in ${b.handle.providerRef}; gateway ${stack.gatewayUrl}`,
    );
  }, 240_000);

  afterAll(async () => {
    const summary = writeReports();
    if (summary) console.log(`[m2-ab] summary\n${formatAbSummary(summary)}`);
    await stopStack(stack);
    stack = undefined;
  }, 180_000);

  for (let round = 1; round <= rounds; round++) {
    for (const arm of AB_ARMS) {
      it(
        `round ${round} arm ${arm}: chief delegates to two experts and combines their results`,
        () => executeArm(arm, round),
        8 * 60_000,
      );
    }
  }
});
