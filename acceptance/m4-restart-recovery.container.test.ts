// T2 fault test for ADR-0029 decisions 4, 5 and 9 on the real stack (Gateway, workspace
// container, sidecar, Agent SDK 0.3.278) with a scripted upstream and no model. The Gateway is
// stopped while a sidecar is live in the middle of a long shell call; a new Gateway on the same
// database must kill that sidecar by its run marker, refuse its old token, and resume the run on
// its SDK session as attempt 2 with the interrupted call named, never re-executed by the platform.
// Skipped without Docker.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "./support/docker.js";
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

const available = await dockerAvailable();
const TOKEN = "adr29-restart-fake";
const SOUL = "# adr29 restart\nADR29_RESTART_SOUL: run the long step with the shell.";
const LONG_STEP = "sleep 300; echo ADR29_LONG_STEP >> /work/adr29-restart-proof.txt";
const RESTART_NOTICE = "A platform restart stopped this run";
const JOURNEY_TIMEOUT_MS = 240_000;

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + JOURNEY_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

describe.skipIf(!available)(
  "ADR-0029 restart recovery (real Docker/SDK, scripted upstream)",
  () => {
    let upstream: FakeModelUpstream | undefined;
    let stack: Stack | undefined;
    let run: RunView;

    beforeAll(async () => {
      upstream = await startFakeModelUpstream({
        expectedToken: TOKEN,
        reply: "",
        script: async (_turn, body): Promise<FakeTurn> => {
          const conversation = JSON.stringify(body?.messages ?? []);
          if (!JSON.stringify(body?.system ?? "").includes("ADR29_RESTART_SOUL"))
            return { kind: "text", text: assistantText("") };
          if (conversation.includes(RESTART_NOTICE))
            return { kind: "text", text: assistantText("ADR29_RESUMED") };
          return {
            kind: "tool_use",
            name: "Bash",
            input: { command: LONG_STEP, description: "the long step", timeout: 600_000 },
          };
        },
      });
      stack = await startStack({
        modelBaseUrl: upstream.url,
        modelAuthToken: TOKEN,
        defaultModel: "fake-adr29",
        cheapModel: "fake-adr29-cheap",
        label: "adr29-restart",
        soul: SOUL,
      });
    }, 180_000);

    afterAll(async () => {
      await stopStack(stack);
      await upstream?.close();
    }, 120_000);

    it(
      "a restart kills the live sidecar, revokes its token, and resumes the run on its session",
      async () => {
        const s = stack as Stack;
        ({ run } = await postMessage(s, "ADR29 run the long step"));
        // The run is live and inside its long shell call, and its session has been reported.
        await until("the long call to start", async () => {
          const { run: now } = await getRun(s, run.id);
          const events = s.app.deskmates.ctx.events.list(run.id);
          return now.status === "running" &&
            now.sdkSessionId !== undefined &&
            events.some((e) => e.kind === "tool_call")
            ? true
            : undefined;
        });
        const before = s.app.deskmates.ctx.runs.mustGet(run.id);
        const oldToken = s.app.deskmates.ctx.tokens.issue(run.id).token;

        await restartGateway(s);

        // Decision 4: the old sidecar was killed by marker before anything resumed.
        expect(s.provider.killedRuns).toContain(run.id);
        const survivors = await s.provider.exec(s.handle, {
          cmd: [
            "/bin/sh",
            "-c",
            'for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "DESKMATES_RUN_ID=$0" && echo "$p"; done; exit 0',
            run.id,
          ],
          timeoutMs: 15_000,
        });
        expect(survivors.stdout.trim()).toBe("");

        // Decision 9: the old token is dead on the model proxy and the internal routes.
        for (const path of ["/v1/messages", `/internal/runs/${run.id}/events`]) {
          const res = await fetch(`${s.gatewayUrl}${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json" },
            body: "[]",
          });
          expect(res.status, path).toBe(401);
        }

        const ended = await waitForRun(s, run.id, JOURNEY_TIMEOUT_MS);
        expect(ended.status).toBe("succeeded");
        expect(ended.attempt).toBe(2);
        expect(ended.sdkSessionId).toBe(before.sdkSessionId);
        // Decision 5: the resumed first turn named the interrupted call; the platform did not repeat
        // it, so the long step never wrote its proof.
        const resumedRequests = (upstream as FakeModelUpstream).requests.filter((r) =>
          r.rawBody.includes(RESTART_NOTICE),
        );
        expect(resumedRequests.length).toBeGreaterThan(0);
        expect(resumedRequests[0]?.rawBody).toContain("(Bash, ");
        // The resumed request carries the old transcript: the long step's tool call is in it.
        expect(resumedRequests[0]?.rawBody).toContain("ADR29_LONG_STEP");
        const proof = await s.provider.exec(s.handle, {
          cmd: ["/bin/sh", "-c", "cat /work/adr29-restart-proof.txt 2>/dev/null; exit 0"],
          timeoutMs: 15_000,
        });
        expect(proof.stdout).not.toContain("ADR29_LONG_STEP");
        // Decision 8: the killed attempt's usage came from its proxied requests.
        const rows = s.app.deskmates.ctx.usage.listByAttempt(run.id);
        expect(rows.find((r) => r.attempt === 1)?.source).toBe("proxy");
      },
      JOURNEY_TIMEOUT_MS + 60_000,
    );
  },
);
