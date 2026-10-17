// T1: the CLI surface travels with a run (ADR-0023 amendment 5, decision 24). The run row records
// the effective values at creation, and the sidecar gets them from the row, not from the
// Gateway's current configuration; with nothing configured the start request has no field.

import type { RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

async function webhookRun() {
  const { bot } = await h.seed();
  h.provider.onRun(async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "swept",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "",
      },
      usage: [],
    });
  });
  const ctx = h.app.deskmates.ctx;
  return ctx.runs.create({
    botId: bot.id,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: "whk_cli",
    triggerPayload: { body: "ping" },
    config: ctx.runConfig(),
  });
}

async function finish(runId: RunId) {
  h.app.deskmates.scheduler.kick();
  await waitFor(() => h.app.deskmates.ctx.runs.mustGet(runId).status === "succeeded", 3000, "run");
}

describe("cliSurface", () => {
  it("records the CLI's defaults and sends nothing when nothing is configured", async () => {
    const run = await webhookRun();
    expect(run.config.cliSurface).toEqual({
      version: 1,
      disallowedTools: [],
      disableBundledSkills: null,
      includeGitInstructions: null,
      skillListingMaxDescChars: null,
    });
    await finish(run.id);
    expect(h.provider.execCalls[0]?.request).not.toHaveProperty("cliSurface");
  });

  it("sends the values the run was created with, whatever the Gateway says later", async () => {
    h.app.deskmates.ctx.config.cliSurface = {
      disallowedTools: ["NotebookEdit"],
      disableBundledSkills: true,
      includeGitInstructions: false,
    };
    const run = await webhookRun();
    // The Gateway is reconfigured while the run waits; the run keeps what it was created with.
    h.app.deskmates.ctx.config.cliSurface = { disallowedTools: ["TodoWrite"] };
    await finish(run.id);
    expect(run.config.cliSurface).toMatchObject({
      disallowedTools: ["NotebookEdit"],
      disableBundledSkills: true,
      includeGitInstructions: false,
      skillListingMaxDescChars: null,
    });
    expect(h.provider.execCalls[0]?.request.cliSurface).toEqual({
      disallowedTools: ["NotebookEdit"],
      disableBundledSkills: true,
      includeGitInstructions: false,
    });
  });
});
