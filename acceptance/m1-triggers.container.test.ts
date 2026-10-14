// T2: the M1 trigger paths that are not a chat message, with no model. A real Gateway, a real
// workspace container, the real `deskmates-sidecar` binary and the real Agent SDK, against the same
// fake upstream `m0-stack.container.test.ts` uses.
//
// Three things are proven here and nowhere else:
//
// 1. A webhook is a run. `POST /hooks/:botId/:token` with a raw body returns 202 and a run id;
//    that run goes all the way through the container, the sidecar and the SDK to `succeeded`,
//    carries `triggerKind: "webhook"` on the `background` lane and has no thread — nobody posted
//    a message, so there is nothing for a reply to land in.
// 2. The body reaches the model as data. The sidecar renders a webhook payload inside
//    `<untrusted source="webhook">` (`packages/sidecar/src/context.ts`, design v0.3 §3.10), and
//    the fake upstream records the raw request the SDK's CLI sent, so the wrapper can be asserted
//    on the wire rather than on the sidecar's own unit output.
// 3. The two lanes are real. A chat message and a webhook posted at the same moment produce an
//    `interactive` run and a `background` run that are both `running` at once — the design says
//    one run per lane, not one run per bot, and a single-lane scheduler would serialise these.
//
// The token is the whole of the webhook's authentication: a wrong one is a 404 that creates
// nothing, which is what stops an unauthenticated POST from costing a model call.
//
// Skips when the Docker daemon is unreachable (`colima start`). No model variables needed.

import { isTerminal } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import { type FakeModelUpstream, startFakeModelUpstream } from "./support/fake-model-upstream.js";
import {
  type RunStatusEvent,
  type RunView,
  type SseCollector,
  collectRunStatuses,
  describeStatuses,
  postMessage,
  runEvents,
  runsForBot,
  waitForRun,
} from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const UPSTREAM_TOKEN = "fake-upstream-token-never-leaves-the-gateway-9b7e";
const FAKE_MODEL = "fake-upstream-model";
const FAKE_CHEAP_MODEL = "fake-upstream-model-cheap";

const RUN_TIMEOUT_MS = 5 * 60_000;

/** The webhook payload; `id` is a number so JSON escaping in the upstream body is visible. */
const WEBHOOK_BODY = '{"event":"ticket.created","id":42}';

/**
 * The opening tag as it appears inside a JSON string in the raw upstream body: the SDK's CLI
 * sends the prompt as JSON, so every `"` of the tag arrives escaped. Asserting the escaped form
 * is what makes this a wire-level check instead of a second copy of the sidecar's unit test.
 */
const WRAPPER_IN_JSON = '<untrusted source=\\"webhook\\">';

const dockerUp = await dockerAvailable();
if (!dockerUp) console.warn("[m1-triggers.container.test] Docker daemon unreachable; skipping T2.");

/** `POST /hooks/:botId/:token` with a raw body and no Gateway credential of any kind. */
async function postWebhook(
  stack: Stack,
  token: string,
  body: string,
): Promise<{ status: number; json: { runId?: string; error?: string } }> {
  const res = await fetch(`${stack.gatewayUrl}/hooks/${stack.bot.id}/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  let json: { runId?: string; error?: string } = {};
  try {
    json = text === "" ? {} : (JSON.parse(text) as { runId?: string; error?: string });
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

/** Index of the first frame of `runId` with `status`, or -1. */
function frameIndex(
  statuses: readonly RunStatusEvent[],
  runId: string,
  match: (s: RunStatusEvent) => boolean,
): number {
  return statuses.findIndex((s) => s.run.id === runId && match(s));
}

describe.skipIf(!dockerUp)(
  "M1 triggers (T2): webhook and lanes through the real Gateway, container, sidecar and SDK",
  () => {
    let upstream: FakeModelUpstream;
    let stack: Stack | undefined;
    let sse: SseCollector | undefined;
    let webhookRun: RunView | undefined;

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({ reply: "pong", expectedToken: UPSTREAM_TOKEN });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: UPSTREAM_TOKEN,
        defaultModel: FAKE_MODEL,
        cheapModel: FAKE_CHEAP_MODEL,
        label: "triggers",
      });
      // Unfiltered: a webhook run has no thread, so a thread-scoped stream would never see it.
      sse = await collectRunStatuses(stack);
    }, 25 * 60_000);

    afterAll(async () => {
      sse?.close();
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it("the bot was created with a webhook token, shown once", () => {
      const s = stack as Stack;
      expect(
        s.webhookToken.length,
        "POST /api/bots must return a webhookToken (M1 batch 2)",
      ).toBeGreaterThanOrEqual(16);
    });

    it(
      "a webhook POST becomes a background run that succeeds through the container and the SDK",
      async () => {
        const s = stack as Stack;
        const started = Date.now();
        const accepted = await postWebhook(s, s.webhookToken, WEBHOOK_BODY);
        expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
        const runId = accepted.json.runId;
        expect(typeof runId, "202 body carries the run id").toBe("string");

        const final = await waitForRun(s, runId as string, RUN_TIMEOUT_MS, {
          onStatus: (status) =>
            console.log(
              `[m1-triggers] webhook run ${status} (+${Math.round((Date.now() - started) / 1000)}s)`,
            ),
        });
        webhookRun = final;
        if (final.status !== "succeeded") {
          console.error("[m1-triggers] webhook run error:", final.error);
          console.error(
            "[m1-triggers] sidecar stderr:",
            s.provider
              .sidecarRuns()
              .find((entry) => entry.request.runId === final.id)
              ?.exec.result?.stderr.slice(-4000),
          );
          console.error(
            "[m1-triggers] events:",
            JSON.stringify(await runEvents(s, final.id), null, 2).slice(0, 8000),
          );
        }
        expect(final.status, final.error).toBe("succeeded");
        expect(final.triggerKind).toBe("webhook");
        expect(final.lane).toBe("background");
        // No thread: a webhook is nobody's message, so the reply has nowhere to land.
        expect(final.threadId).toBeUndefined();
        // Nothing parked and nothing replayed: a webhook run is one attempt.
        expect(final.attempt).toBe(1);

        await new Promise((r) => setTimeout(r, 200));
        expect(describeStatuses(sse?.statuses ?? [], final.id)).toEqual([
          "queued",
          "running",
          "succeeded",
        ]);
      },
      RUN_TIMEOUT_MS + 60_000,
    );

    it('the webhook body reached the model inside an <untrusted source="webhook"> wrapper', () => {
      const run = webhookRun as RunView;
      expect(run.status).toBe("succeeded");
      // The CLI's first call generates a session title and carries no tools; the turn that
      // matters is one of the requests whose raw body holds the rendered trigger.
      const wrapped = upstream.requests.filter((r) => r.rawBody.includes(WRAPPER_IN_JSON));
      expect(
        wrapped.length,
        `no upstream request carried ${WRAPPER_IN_JSON}; saw ${upstream.requests.length} request(s)`,
      ).toBeGreaterThanOrEqual(1);
      for (const r of wrapped) {
        // The payload is inside the wrapper, not next to it: the opening tag comes first and the
        // event text follows it before the wrapper closes.
        const open = r.rawBody.indexOf(WRAPPER_IN_JSON);
        const event = r.rawBody.indexOf("ticket.created", open);
        const close = r.rawBody.indexOf("</untrusted>", open);
        expect(event, "the webhook payload after the opening tag").toBeGreaterThan(open);
        expect(close, "the wrapper closes").toBeGreaterThan(event);
        // JSON escaping, spelled out: the body's own quotes arrive escaped too.
        expect(r.rawBody).toContain('\\"event\\":\\"ticket.created\\"');
      }
      console.log(
        `[m1-triggers] ${wrapped.length} of ${upstream.requests.length} upstream request(s) carried the wrapper`,
      );
    });

    it("a wrong token is a 404 and creates no run", async () => {
      const s = stack as Stack;
      const before = await runsForBot(s);
      const rejected = await postWebhook(s, `${s.webhookToken}-wrong`, WEBHOOK_BODY);
      expect(rejected.status).toBe(404);
      // A moment for a run row that should never exist to appear anyway.
      await new Promise((r) => setTimeout(r, 500));
      const after = await runsForBot(s);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    });

    it(
      "a chat message and a webhook run at the same time, one per lane",
      async () => {
        const s = stack as Stack;
        const started = Date.now();
        const [chat, hook] = await Promise.all([
          postMessage(s, "ping"),
          postWebhook(s, s.webhookToken, '{"event":"ticket.updated","id":43}'),
        ]);
        expect(hook.status).toBe(202);
        const chatRunId = chat.run.id;
        const hookRunId = hook.json.runId as string;
        expect(chat.run.lane).toBe("interactive");

        const [chatFinal, hookFinal] = await Promise.all([
          waitForRun(s, chatRunId, RUN_TIMEOUT_MS, {
            onStatus: (st) =>
              console.log(
                `[m1-triggers] chat run ${st} (+${Math.round((Date.now() - started) / 1000)}s)`,
              ),
          }),
          waitForRun(s, hookRunId, RUN_TIMEOUT_MS, {
            onStatus: (st) =>
              console.log(
                `[m1-triggers] lane webhook run ${st} (+${Math.round((Date.now() - started) / 1000)}s)`,
              ),
          }),
        ]);
        expect(chatFinal.status, chatFinal.error).toBe("succeeded");
        expect(hookFinal.status, hookFinal.error).toBe("succeeded");
        expect(hookFinal.lane).toBe("background");

        await new Promise((r) => setTimeout(r, 200));
        const statuses = sse?.statuses ?? [];
        const running = (id: string) => frameIndex(statuses, id, (f) => f.run.status === "running");
        const terminal = (id: string) => frameIndex(statuses, id, (f) => isTerminal(f.run.status));
        const chatRunning = running(chatRunId);
        const hookRunning = running(hookRunId);
        const chatEnd = terminal(chatRunId);
        const hookEnd = terminal(hookRunId);
        console.log(
          `[m1-triggers] frames: chat running@${chatRunning} end@${chatEnd}, ` +
            `webhook running@${hookRunning} end@${hookEnd}`,
        );
        expect(chatRunning, "chat run seen running").toBeGreaterThanOrEqual(0);
        expect(hookRunning, "webhook run seen running").toBeGreaterThanOrEqual(0);
        expect(chatEnd, "chat run seen terminal").toBeGreaterThanOrEqual(0);
        expect(hookEnd, "webhook run seen terminal").toBeGreaterThanOrEqual(0);
        // Both were running at once: whichever started second was running before the other ended.
        expect(hookRunning, "webhook running before the chat run ended").toBeLessThan(chatEnd);
        expect(chatRunning, "chat running before the webhook run ended").toBeLessThan(hookEnd);
      },
      RUN_TIMEOUT_MS + 60_000,
    );
  },
);
