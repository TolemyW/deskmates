// T1 (ADR-0048 amendment 1, A3 and A4) over the run-token routes: two bots' runs in one workspace
// hold shared desktop leases at once; an exclusive lease makes the other wait and refuses a browser
// acquire (not a renewal) until it is released; a takeover refuses every lease; a stored
// `desktop`/`egress_denied` event leaves an `egress.desktop_denied` audit row.

import {
  DESKTOP_INPUT_BLOCKS_BROWSER_MESSAGE,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type StartRunRequest,
  type Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit/audit-log.js";
import { hashWebhookToken, newWebhookToken } from "../bots/webhook-token.js";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

interface Live {
  gw: FakeSidecarClient;
  req: StartRunRequest;
}

async function twoLiveRuns(): Promise<{ workspace: Workspace; a: Live; b: Live; end: () => void }> {
  const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", { name: "desk" });
  const workspace = ws.json.workspace;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live: Live[] = [];
  h.provider.onRun(async (req, gw) => {
    live.push({ gw, req });
    await gate;
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "ok",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    });
  });
  for (const name of ["nova", "vega"]) {
    const bot = h.app.deskmates.ctx.bots.create({
      name,
      role: "tester",
      workspaceId: workspace.id,
      webhookTokenHash: hashWebhookToken(newWebhookToken()),
    });
    const thread = h.app.deskmates.ctx.privateChats.resolve(bot.id);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: `hello @${name}` },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "running",
      3000,
      "run running",
    );
  }
  await waitFor(() => live.length === 2, 3000, "two sidecars");
  return { workspace, a: live[0] as Live, b: live[1] as Live, end: release };
}

const lock = async (live: Live, body: Record<string, unknown>) =>
  (await (
    await live.gw.post("desktop-lock", { type: "desktop_lock", runId: live.req.runId, ...body })
  ).json()) as { granted: boolean; contended?: boolean; waitMessage?: string };

const browser = async (live: Live, op: string) =>
  (await (
    await live.gw.post("browser-lock", { type: "browser_lock", runId: live.req.runId, op })
  ).json()) as { granted: boolean; waitMessage?: string };

describe("desktop-lock route (ADR-0048 amendment 1, A3)", () => {
  it("shares focus-free leases, excludes raw input, fences browser acquires, stops on takeover", async () => {
    const { workspace, a, b, end } = await twoLiveRuns();
    expect(await lock(a, { op: "acquire", callId: "1", mode: "shared" })).toMatchObject({
      granted: true,
    });
    expect(await lock(b, { op: "acquire", callId: "1", mode: "shared" })).toMatchObject({
      granted: true,
    });
    await lock(a, { op: "release", callId: "1" });
    await lock(b, { op: "release", callId: "1" });

    expect(await browser(b, "acquire")).toMatchObject({ granted: true });
    expect(await lock(a, { op: "acquire", callId: "2", mode: "exclusive" })).toMatchObject({
      granted: true,
    });
    expect(await lock(b, { op: "acquire", callId: "2", mode: "shared" })).toMatchObject({
      granted: false,
      contended: true,
    });
    expect(await browser(b, "acquire")).toEqual(
      expect.objectContaining({
        granted: false,
        waitMessage: DESKTOP_INPUT_BLOCKS_BROWSER_MESSAGE,
      }),
    );
    expect(await browser(b, "renew")).toMatchObject({ granted: true });
    await lock(a, { op: "release", callId: "2" });
    expect(await browser(b, "acquire")).toMatchObject({ granted: true });

    await h.api("POST", `/api/workspaces/${workspace.id}/takeover`, { authorId: "ops" });
    for (const live of [a, b])
      expect(await lock(live, { op: "acquire", callId: "3", mode: "shared" })).toMatchObject({
        granted: false,
        waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
      });
    await h.api("POST", `/api/workspaces/${workspace.id}/handback`, { authorId: "ops" });

    expect((await a.gw.post("desktop-lock", { op: "acquire", callId: "4" })).status).toBe(400);
    end();
  });

  it("audits a desktop network denial when its event is stored (A4)", async () => {
    const { workspace, a, end } = await twoLiveRuns();
    await a.gw.post("events", [
      {
        type: "event",
        runId: a.req.runId,
        attempt: a.req.attempt,
        seq: 1,
        kind: "log",
        payload: {
          source: "desktop",
          op: "egress_denied",
          level: "warn",
          host: "10.0.0.5",
          kind: "hard_deny",
          reason: "egress_blocked: desktop code names 10.0.0.5",
          toolName: "mcp__desktop__js",
          toolUseId: "toolu_9",
        },
      },
    ]);
    const rows = new AuditLog(h.app.deskmates.ctx.db)
      .list({ workspaceId: workspace.id })
      .filter((r) => r.action === "egress.desktop_denied");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetId: "10.0.0.5", runId: a.req.runId });
    end();
  });
});
