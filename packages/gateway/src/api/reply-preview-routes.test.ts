// T1: the Gateway's half of the streamed reply preview (ADR-0037 decision 7). A live run's frames
// are relayed to its thread's stream in seq order, stale and duplicate frames are dropped, a frame
// of another attempt or of an ended run is not relayed, nothing but the first-frame timeline mark
// enters the ledger, and the final reply message still arrives as before.

import type { RunId, ThreadMessage } from "@deskmates/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { GatewayEvent } from "../events/bus.js";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, openSse, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const frame = (runId: string, attempt: number, seq: number, text: string) => ({
  type: "reply_preview",
  runId,
  attempt,
  seq,
  text,
});

it("relays a live run's frames in order and leaves the final reply authoritative", async () => {
  const { thread } = await h.seed();
  const sse = await openSse(h.baseUrl, `?threadId=${thread.id}`);
  const answers: unknown[] = [];
  h.provider.onRun(async (req, gw) => {
    for (const body of [
      frame(req.runId, req.attempt, 1, "Hel"),
      frame(req.runId, req.attempt, 1, "Hel"),
      frame(req.runId, req.attempt, 3, "Hello wor"),
      frame(req.runId, req.attempt, 2, "Hello"),
      frame(req.runId, req.attempt + 1, 9, "another attempt"),
    ]) {
      const res = await gw.post("reply-preview", body);
      answers.push([res.status, await res.json()]);
    }
    const malformed = await gw.post("reply-preview", { type: "reply_preview", runId: req.runId });
    answers.push([malformed.status]);
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "d",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "Hello world",
      },
      usage: [],
    });
    const late = await gw.post("reply-preview", frame(req.runId, req.attempt, 4, "late"));
    answers.push([late.status]);
  });
  const posted = await h.api<{ runs: RunRecord[] }>("POST", `/api/threads/${thread.id}/messages`, {
    body: "hi",
  });
  const runId = posted.json.runs[0]?.id as RunId;
  await waitFor(
    () => sse.events.some((e) => e.type === "thread_message" && e.message.authorKind === "bot"),
    3000,
    "final reply",
  );
  await h.app.deskmates.scheduler.drain();
  sse.close();

  expect(answers).toEqual([
    [200, { ok: true, accepted: true }],
    [200, { ok: true, accepted: false }],
    [200, { ok: true, accepted: true }],
    [200, { ok: true, accepted: false }],
    [200, { ok: true, accepted: false }],
    [400],
    // The run ended: the token is revoked with it, so a late frame cannot even be delivered.
    [401],
  ]);
  const previews = sse.events.filter(
    (e): e is Extract<GatewayEvent, { type: "run_reply_preview" }> =>
      e.type === "run_reply_preview",
  );
  expect(previews.map((e) => [e.preview.seq, e.preview.text])).toEqual([
    [1, "Hel"],
    [3, "Hello wor"],
  ]);
  expect(previews[0]?.preview).toMatchObject({ runId, threadId: thread.id, attempt: 1 });
  const final = sse.events.find(
    (e): e is { type: "thread_message"; threadId: typeof thread.id; message: ThreadMessage } =>
      e.type === "thread_message" && e.message.authorKind === "bot",
  );
  expect(final?.message.body).toBe("Hello world");
  // The last preview went out before the authoritative reply.
  expect(sse.events.indexOf(previews[1] as GatewayEvent)).toBeLessThan(
    sse.events.indexOf(final as GatewayEvent),
  );

  const ledger = h.app.deskmates.ctx.events.list(runId);
  const previewMarks = ledger.filter(
    (e) => e.payload.source === "run_timeline" && e.payload.mark === "reply_preview_published",
  );
  expect(previewMarks).toHaveLength(1);
  expect(ledger.some((e) => JSON.stringify(e.payload).includes("Hello wor"))).toBe(false);
});
