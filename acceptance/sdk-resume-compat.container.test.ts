// T2 release gate of ADR-0029 decision 10: a session parked by the old workspace image resumes on
// the new one. Run it when a release changes the pinned Agent SDK, with
// DESKMATES_OLD_WORKSPACE_IMAGE set to the current release's workspace image (the new one is
// WORKSPACE_IMAGE, as for every T2 file). A drain parks a run on the old image at a safe point; the
// Gateway is restarted on the new image, which replaces the container and keeps the named volumes
// that hold the session; the resumed attempt's first request must carry the old transcript.
// Skipped without Docker or without the old image.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, workspaceImage } from "./support/docker.js";
import {
  type FakeModelUpstream,
  type FakeTurn,
  assistantText,
  startFakeModelUpstream,
} from "./support/fake-model-upstream.js";
import { restartGateway } from "./support/restart-gateway.js";
import { POLL_MS, type RunView, getRun, postMessage, waitForRun } from "./support/runs.js";
import { type Stack, startStack } from "./support/start-stack.js";
import { stopStack } from "./support/stop-stack.js";

const OLD_IMAGE = process.env.DESKMATES_OLD_WORKSPACE_IMAGE?.trim() ?? "";
const available = OLD_IMAGE !== "" && (await dockerAvailable());
const TOKEN = "adr29-compat-fake";
const SOUL = "# adr29 compat\nADR29_COMPAT_SOUL: run the steps with the shell.";
const MARKER = "ADR29_COMPAT_OLD_TRANSCRIPT";
const DRAIN_NOTICE = "The platform paused this run for an upgrade";
const JOURNEY_TIMEOUT_MS = 300_000;
const HOLD_MS = 15_000;

describe.skipIf(!available)(
  "ADR-0029 resume across an SDK change (old image parks, new resumes)",
  () => {
    let upstream: FakeModelUpstream | undefined;
    let stack: Stack | undefined;
    let run: RunView;
    let drainStarted: () => void = () => undefined;
    const drained = new Promise<void>((resolve) => {
      drainStarted = resolve;
    });
    let secondAsked: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      secondAsked = resolve;
    });

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: TOKEN,
        reply: "",
        script: async (_turn, body): Promise<FakeTurn> => {
          if (!JSON.stringify(body?.system ?? "").includes("ADR29_COMPAT_SOUL"))
            return { kind: "text", text: assistantText("") };
          const conversation = JSON.stringify(body?.messages ?? []);
          if (conversation.includes(DRAIN_NOTICE) || conversation.split('"tool_result"').length > 2)
            return { kind: "text", text: assistantText("ADR29_COMPAT_DONE") };
          if (!conversation.includes(MARKER))
            return { kind: "tool_use", name: "Bash", input: { command: `echo ${MARKER}` } };
          secondAsked();
          await drained;
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          return { kind: "tool_use", name: "Bash", input: { command: "echo ADR29_COMPAT_SECOND" } };
        },
      });
      const newImage = process.env.WORKSPACE_IMAGE;
      process.env.WORKSPACE_IMAGE = OLD_IMAGE;
      try {
        stack = await startStack({
          modelBaseUrl: upstream.url,
          modelAuthToken: TOKEN,
          defaultModel: "fake-adr29",
          cheapModel: "fake-adr29-cheap",
          label: "adr29-compat",
          soul: SOUL,
        });
      } finally {
        if (newImage === undefined) Reflect.deleteProperty(process.env, "WORKSPACE_IMAGE");
        else process.env.WORKSPACE_IMAGE = newImage;
      }
    }, 240_000);

    afterAll(async () => {
      drainStarted();
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it(
      "a session parked on the old image resumes on the new image with its transcript",
      async () => {
        const s = stack as Stack;
        expect(s.config.workspaceImage).toBe(OLD_IMAGE);
        ({ run } = await postMessage(s, "ADR29 compat"));
        await asked;
        await s.api("POST", "/api/runtime/drain");
        drainStarted();
        const deadline = Date.now() + JOURNEY_TIMEOUT_MS;
        for (;;) {
          const { run: now } = await getRun(s, run.id);
          if (now.status === "waiting_platform") break;
          if (Date.now() > deadline) throw new Error(`run still ${now.status}`);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        const session = s.app.deskmates.ctx.runs.mustGet(run.id).sdkSessionId;
        const oldSdk = s.app.deskmates.ctx.runs.mustGet(run.id).config.sdkVersion;

        await restartGateway(s, { workspaceImage: workspaceImage() });

        const ended = await waitForRun(s, run.id, JOURNEY_TIMEOUT_MS);
        expect(ended.status).toBe("succeeded");
        expect(ended.attempt).toBe(2);
        expect(ended.sdkSessionId).toBe(session);
        const resumed = (upstream as FakeModelUpstream).requests.find((r) =>
          r.rawBody.includes(DRAIN_NOTICE),
        );
        expect(resumed?.rawBody).toContain(MARKER);
        // No fresh-session fallback was needed; the version change, if any, is on the run's ledger.
        const events = s.app.deskmates.ctx.events.list(run.id);
        expect(events.some((e) => e.payload.op === "resume_failed")).toBe(false);
        expect(s.app.deskmates.ctx.runs.mustGet(run.id).config.sdkVersion).toBe(oldSdk);
      },
      JOURNEY_TIMEOUT_MS + 60_000,
    );
  },
);
