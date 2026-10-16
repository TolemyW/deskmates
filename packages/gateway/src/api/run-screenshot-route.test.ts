// T1, issue #9: GET /api/runs/:id/screenshot answers the run's newest screenshot event, the
// thumbnail an approval card shows, or null when the run took none.

import type { RunEvent, RunId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe("GET /api/runs/:id/screenshot (issue #9)", () => {
  it("returns the newest screenshot, null before the first, 404 for an unknown run", async () => {
    const { bot, thread } = await h.seed();
    const { ctx } = h.app.deskmates;
    const run = ctx.runs.create({
      botId: bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: "msg_x",
    });
    const none = await h.api<{ screenshot: RunEvent | null }>(
      "GET",
      `/api/runs/${run.id}/screenshot`,
    );
    expect(none).toEqual({ status: 200, json: { screenshot: null } });

    const shot = (action: number) => ({
      runId: run.id,
      kind: "screenshot" as const,
      payload: { action, mimeType: "image/jpeg", base64: `img${action}`, toolUseId: `t${action}` },
    });
    ctx.events.append(shot(1));
    ctx.events.append(shot(2));
    ctx.events.append({ runId: run.id, kind: "log", payload: { source: "assistant", text: "x" } });
    const latest = await h.api<{ screenshot: RunEvent | null }>(
      "GET",
      `/api/runs/${run.id}/screenshot`,
    );
    expect(latest.json.screenshot).toMatchObject({ seq: 2, payload: { action: 2 } });

    const missing = await h.api("GET", `/api/runs/${"run_missing" as RunId}/screenshot`);
    expect(missing.status).toBe(404);
  });
});
