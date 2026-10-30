// T1 (ADR-0049 decision 12): what a run freezes from the switch. Attempt 1 records `webSearch`
// on an installation that configures search; a later attempt reads it back whatever the switch
// says now; a Gateway job is off; an installation without `SEARCH_URL` records nothing.

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { readSearchConfig } from "../config/search.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import { startHarness } from "../test-support/harness.js";
import { webSearchSettings, withWebSearch } from "./web-search-settings.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(overrides: Partial<GatewayConfig>) {
  const h = await startHarness(overrides);
  cleanup.push(() => h.close());
  const { bot, thread, workspace } = await h.seed();
  const { ctx } = h.app.deskmates;
  const newRun = (config: Record<string, unknown> = ctx.runConfig()) =>
    ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "test",
      config,
    });
  return { ctx, workspace, newRun };
}

const configured = () => readSearchConfig({ SEARCH_URL: "http://fake-searxng.test" });

describe("freezing webSearch on the run row", () => {
  it("inherits on when configured, preserves explicit off and resets to on", async () => {
    const { ctx, workspace, newRun } = await setup(configured());
    const settings = webSearchSettings(ctx);
    expect(settings.view(workspace.id)).toMatchObject({
      enabled: null,
      defaultEnabled: true,
      effective: true,
    });
    expect(sidecarToolsFor(true, withWebSearch(ctx, newRun(), workspace.id))).toContain(
      "web_search",
    );
    settings.set(workspace.id, { enabled: false }, "user:test");
    const off = newRun();
    expect(sidecarToolsFor(true, withWebSearch(ctx, off, workspace.id))).not.toContain(
      "web_search",
    );
    settings.set(workspace.id, { enabled: null }, "user:test");
    expect(settings.effective(workspace.id)).toBe(true);
    expect(
      settings.freeze(ctx.runs, { ...ctx.runs.mustGet(off.id), attempt: 2 }, workspace.id),
    ).toBe(false);
  });
  it("records on at attempt 1 and keeps it on a later attempt after the switch went off", async () => {
    const { ctx, workspace, newRun } = await setup(configured());
    const settings = webSearchSettings(ctx);
    settings.set(workspace.id, { enabled: true }, "user:test");
    const run = newRun();
    const config = withWebSearch(ctx, run, workspace.id);
    expect(sidecarToolsFor(true, config)).toContain("web_search");
    const frozen = ctx.runs.mustGet(run.id);
    expect(frozen.config).toMatchObject({
      webSearch: "on",
      webSearchVersion: 1,
      webSearchEndpointSha256: ctx.config.search?.endpointSha256,
    });
    settings.set(workspace.id, { enabled: false }, "user:test");
    const resumed = { ...frozen, attempt: 2, status: "waiting_approval" as const };
    expect(settings.freeze(ctx.runs, resumed, workspace.id)).toBe(true);
    expect(sidecarToolsFor(true, withWebSearch(ctx, resumed, workspace.id))).toContain(
      "web_search",
    );
    // A run that starts now is off.
    const later = newRun();
    expect(sidecarToolsFor(true, withWebSearch(ctx, later, workspace.id))).not.toContain(
      "web_search",
    );
    expect(ctx.runs.mustGet(later.id).config).toMatchObject({ webSearch: "off" });
  });

  it("records off for a Gateway job even when the switch is on", async () => {
    const { ctx, workspace, newRun } = await setup(configured());
    webSearchSettings(ctx).set(workspace.id, { enabled: true }, "user:test");
    const job = newRun({ ...ctx.runConfig(), runType: "activity_summary" });
    expect(webSearchSettings(ctx).freeze(ctx.runs, job, workspace.id)).toBe(false);
    expect(ctx.runs.mustGet(job.id).config).toMatchObject({ webSearch: "off" });
  });

  it("never gains the tool on a later attempt that was not frozen at attempt 1", async () => {
    const { ctx, workspace, newRun } = await setup(configured());
    webSearchSettings(ctx).set(workspace.id, { enabled: true }, "user:test");
    const run = newRun();
    const older = { ...run, attempt: 2 };
    expect(webSearchSettings(ctx).freeze(ctx.runs, older, workspace.id)).toBe(false);
    expect(ctx.runs.mustGet(run.id).config.webSearch).toBeUndefined();
  });

  it("records nothing on an installation without SEARCH_URL", async () => {
    const { ctx, workspace, newRun } = await setup({});
    const run = newRun();
    expect(withWebSearch(ctx, run, workspace.id)).toBe(run.config);
    const stored = ctx.runs.mustGet(run.id).config;
    expect(stored.webSearch).toBeUndefined();
    expect(stored.webSearchVersion).toBeUndefined();
    expect(Object.keys(stored).some((k) => k.startsWith("webSearch"))).toBe(false);
  });
});
