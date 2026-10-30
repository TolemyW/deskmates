// T2 for ADR-0029 decision 2 on the real stack (Gateway, workspace container, sidecar, Agent SDK
// 0.3.278) with a scripted upstream and no model. S0 verified `PreToolUse` `defer` for an L2 call;
// this verifies the general case the drain relies on: a drain parks a run at the hook of an
// ordinary (non-L2) shell call, the call does not run, and after the drain the resumed attempt
// replays it through the hook on the same SDK session, exactly once. Skipped without Docker.

import type { RuntimeStatus } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { POLL_MS, type RunView, getRun, postMessage, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const available = await dockerAvailable();
const TOKEN = "adr29-drain-fake";
const SOUL = "# adr29 drain\nADR29_DRAIN_SOUL: run the two steps with the shell.";
const PROOF = "/work/adr29-drain-proof.txt";
const STEP = (n: number) => `echo ADR29_STEP_${n} >> ${PROOF}`;
const DRAIN_NOTICE = "The platform paused this run for an upgrade";
const JOURNEY_TIMEOUT_MS = 240_000;
/** Longer than the sidecar's 10 s resource sample, so a ledger batch carries the drain back. */
const HOLD_MS = 15_000;

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + JOURNEY_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe.skipIf(!available)("ADR-0029 upgrade drain (real Docker/SDK, scripted upstream)", () => {
  let upstream: FakeModelUpstream | undefined;
  let stack: Stack | undefined;
  let run: RunView;
  let drainStarted: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    drainStarted = resolve;
  });
  let secondStepAsked: () => void = () => undefined;
  const askedForSecond = new Promise<void>((resolve) => {
    secondStepAsked = resolve;
  });

  beforeAll(async () => {
    upstream = await startFakeModelUpstream({
      expectedToken: TOKEN,
      reply: "",
      script: async (_turn, body): Promise<FakeTurn> => {
        if (!JSON.stringify(body?.system ?? "").includes("ADR29_DRAIN_SOUL"))
          return { kind: "text", text: assistantText("") };
        const conversation = JSON.stringify(body?.messages ?? []);
        if (conversation.includes("ADR29_STEP_2") && conversation.includes('"tool_result"')) {
          const results = conversation.split('"tool_result"').length - 1;
          if (results >= 2) return { kind: "text", text: assistantText("ADR29_DRAINED_DONE") };
        }
        if (!conversation.includes("ADR29_STEP_1"))
          return { kind: "tool_use", name: "Bash", input: { command: STEP(1) } };
        // The answer that asks for step 2 waits until the drain has started and a batch has
        // carried it back, so the hook of step 2 is the run's safe point.
        secondStepAsked();
        await drained;
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        return { kind: "tool_use", name: "Bash", input: { command: STEP(2) } };
      },
    });
    stack = await startStack({
      modelBaseUrl: upstream.url,
      modelAuthToken: TOKEN,
      defaultModel: "fake-adr29",
      cheapModel: "fake-adr29-cheap",
      label: "adr29-drain",
      soul: SOUL,
    });
  }, 180_000);

  afterAll(async () => {
    drainStarted();
    await stopStack(stack);
    await upstream?.close();
  }, 120_000);

  it(
    "parks at the next non-L2 call, never runs it during the drain, and replays it once after",
    async () => {
      const s = stack as Stack;
      ({ run } = await postMessage(s, "ADR29 run both steps"));
      await askedForSecond;
      const started = await s.api<RuntimeStatus>("POST", "/api/runtime/drain");
      expect(started.json.draining).toBe(true);
      drainStarted();

      const parked = await until("the drained park", async () => {
        const { run: now } = await getRun(s, run.id);
        return now.status === "waiting_platform" ? now : undefined;
      });
      expect(parked.resumePayload?.platform).toBe("drain");
      const session = parked.sdkSessionId;
      expect(session).toBeDefined();
      const runtime = await s.api<RuntimeStatus>("GET", "/api/runtime");
      expect(runtime.json.activeRuns).toBe(0);
      expect(runtime.json.drainParkedRunIds).toContain(run.id);
      const during = await s.provider.exec(s.handle, {
        cmd: ["/bin/sh", "-c", `cat ${PROOF}`],
        timeoutMs: 15_000,
      });
      expect(during.stdout.trim().split("\n")).toEqual(["ADR29_STEP_1"]);

      await s.api("DELETE", "/api/runtime/drain");
      const ended = await waitForRun(s, run.id, JOURNEY_TIMEOUT_MS);
      expect(ended.status).toBe("succeeded");
      expect(ended.attempt).toBe(2);
      expect(ended.sdkSessionId).toBe(session);
      const after = await s.provider.exec(s.handle, {
        cmd: ["/bin/sh", "-c", `cat ${PROOF}`],
        timeoutMs: 15_000,
      });
      expect(after.stdout.trim().split("\n")).toEqual(["ADR29_STEP_1", "ADR29_STEP_2"]);
      // The resumed attempt's first request carries the notice and the old transcript.
      const resumed = (upstream as FakeModelUpstream).requests.find((r) =>
        r.rawBody.includes(DRAIN_NOTICE),
      );
      expect(resumed?.rawBody).toContain("ADR29_STEP_1");
    },
    JOURNEY_TIMEOUT_MS + 60_000,
  );
});
