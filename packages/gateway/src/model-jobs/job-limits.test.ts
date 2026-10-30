// T1, issue #39 item 8: a model job's deadline and thinking come from the Gateway's
// configuration. `MODEL_JOB_DEADLINE_MS` (default 55 s) reaches the sidecar on the
// StartRunRequest, is recorded on the run, and the process is killed five seconds after it;
// `MODEL_JOB_THINKING` (default `disabled`) caps thinking for jobs only, never from the bot; the
// presentation summaries (approval explanation, Activity summary) count as jobs for it.

import type { BotId, MemoryOrganizeJob, StartRunRequest, Workspace } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_PRESENTATION } from "../approvals/presentation.js";
import type { GatewayConfig } from "../config.js";
import { ACTIVITY_SUMMARY } from "../ledger/activity-summaries.js";
import { THINKING_CAPPED_RUN_TYPES } from "../scheduler/run-lifecycle.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { modelJobThinking } from "./model-jobs.js";
import { VISION_PROBE } from "./vision-probes.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function playSidecar(request: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  await gw.post("ended", {
    type: "run_ended",
    runId: request.runId,
    outcome: "completed",
    summary: {
      done: "Memory organisation proposal",
      reply: JSON.stringify({ labels: [], splits: [] }),
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
    },
    usage: [],
  });
}

/** Queue one memory organisation job in a fresh workspace and return its sidecar start. */
async function oneJob(overrides: Partial<GatewayConfig> = {}) {
  h = await startHarness(overrides);
  h.provider.onRun(playSidecar);
  const harness = h;
  const ctx = harness.app.deskmates.ctx;
  const workspace = (
    await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ws",
      egressAllowlist: ["docs.example.test"],
    })
  ).json.workspace;
  // A bot's own reasoning applies to its agent runs, never to its jobs.
  await harness.api("POST", "/api/bots", {
    name: "organiser",
    role: "ops",
    workspaceId: workspace.id,
    welcome: false,
    effort: "xhigh",
    thinking: { type: "adaptive" },
  });
  ctx.memory.entries.insert({
    workspaceId: workspace.id,
    scope: "workspace",
    kind: "note",
    body: "The ledger host is ledger.example.test",
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    by: "test",
  });
  const queued = await harness.api<{ job: MemoryOrganizeJob }>(
    "POST",
    `/api/workspaces/${workspace.id}/memory/organize`,
    {},
  );
  expect(queued.status).toBe(202);
  const call = () => harness.provider.execCalls.find((c) => c.request?.modelJob !== undefined);
  await waitFor(() => call() !== undefined, 3000, "job started");
  const started = call();
  const request = started?.request as StartRunRequest;
  await waitFor(() => ctx.runs.mustGet(request.runId).status === "succeeded", 3000, "job finished");
  return { request, timeoutMs: started?.req.timeoutMs, run: ctx.runs.mustGet(request.runId) };
}

describe("model job limits (issue #39 item 8)", () => {
  it("defaults to a 55 s deadline, a 60 s kill and thinking disabled", async () => {
    // The test configuration's RUN_TIMEOUT_SECONDS is 30; a deployment's default is 1800.
    const { request, timeoutMs, run } = await oneJob({ runTimeoutSeconds: 1800 });
    expect(request.modelJobDeadlineMs).toBe(55_000);
    expect(timeoutMs).toBe(60_000);
    expect(request.thinking).toEqual({ type: "disabled" });
    expect("effort" in request).toBe(false);
    expect(run.config.modelJobDeadlineMs).toBe(55_000);
    expect(run.config.reasoning).toEqual({
      effort: "sdk-default",
      thinking: { type: "disabled" },
      effortSource: "sdk-default",
      thinkingSource: "run",
    });
  });

  it("relays a configured deadline and kills five seconds after it; sdk-default sends no thinking", async () => {
    const { request, timeoutMs, run } = await oneJob({
      modelJobDeadlineMs: 90_000,
      modelJobThinking: "sdk-default",
      runTimeoutSeconds: 1800,
    });
    expect(request.modelJobDeadlineMs).toBe(90_000);
    expect(timeoutMs).toBe(95_000);
    expect("thinking" in request).toBe(false);
    expect(run.config.modelJobDeadlineMs).toBe(90_000);
    expect(run.config.reasoning).toMatchObject({ thinking: "sdk-default" });
  });

  it("never kills a job later than RUN_TIMEOUT_SECONDS", async () => {
    const { timeoutMs } = await oneJob({ modelJobDeadlineMs: 90_000, runTimeoutSeconds: 30 });
    expect(timeoutMs).toBe(30_000);
  });

  it("caps an Activity summary's thinking like a model job, never from the bot", async () => {
    // On stable a cheap model's thinking alone used the summary's 256 output tokens (2026-10-24).
    h = await startHarness();
    h.provider.onRun(playSidecar);
    const harness = h;
    const ctx = harness.app.deskmates.ctx;
    const workspace = (
      await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
        name: "ws",
        egressAllowlist: ["docs.example.test"],
      })
    ).json.workspace;
    const bot = (
      await harness.api<{ bot: { id: BotId } }>("POST", "/api/bots", {
        name: "reporter",
        role: "ops",
        workspaceId: workspace.id,
        welcome: false,
        thinking: { type: "adaptive" },
      })
    ).json.bot;
    const source = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "c",
      triggerPayload: { prompt: "check suppliers" },
      config: {},
    });
    ctx.runs.transition(source.id, "running");
    const done = ctx.runs.transition(source.id, "succeeded", {
      summary: {
        done: "checked",
        reply: "The bot compared every supplier quote, ".repeat(6),
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
      },
    });
    ctx.bus.publish({ type: "run_status", run: done });
    harness.app.deskmates.scheduler.kick();
    const call = () =>
      harness.provider.execCalls.find((c) => c.request?.presentationKind === "activity");
    await waitFor(() => call() !== undefined, 3000, "activity summary started");
    const request = call()?.request as StartRunRequest;
    expect(THINKING_CAPPED_RUN_TYPES.has(ACTIVITY_SUMMARY)).toBe(true);
    expect(THINKING_CAPPED_RUN_TYPES.has(APPROVAL_PRESENTATION)).toBe(true);
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(ctx.runs.mustGet(request.runId).config.reasoning).toMatchObject({
      thinking: { type: "disabled" },
      thinkingSource: "run",
    });
  });

  // A vision probe asks with the request shape of the runs it judges. The SDK sends a disabled
  // key as no key, and one upstream never answered an image request without one.
  it("leaves a vision probe on the SDK's default thinking whatever MODEL_JOB_THINKING says", () => {
    expect(modelJobThinking({ modelJobThinking: "disabled" }, VISION_PROBE)).toBeUndefined();
    expect(modelJobThinking({ modelJobThinking: "sdk-default" }, VISION_PROBE)).toBeUndefined();
    expect(modelJobThinking({ modelJobThinking: "disabled" }, "memory_organize")).toEqual({
      type: "disabled",
    });
  });
});
