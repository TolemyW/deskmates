import { GoldenSiteState } from "@deskmates/golden-site";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunView, getRun, postMessage } from "../../acceptance/support/runs.js";
import type { Stack } from "../../acceptance/support/start-stack.js";
import type { RunObservation } from "./metrics.js";
import { parseMission } from "./mission.js";
import { type DeploymentObservation, observeDeployment } from "./observer.js";
import { runMission } from "./runner.js";

vi.mock("./observer.js", () => ({ observeDeployment: vi.fn() }));
vi.mock("../../acceptance/support/runs.js", async (original) => ({
  ...(await original<typeof import("../../acceptance/support/runs.js")>()),
  getRun: vi.fn(),
  postMessage: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const specText = JSON.stringify({
  id: "read-only",
  version: "1",
  suite: "test",
  description: "read-only accounting control",
  expected: { tickets: [] },
  budgets: { maxTurns: 1, runTimeoutSeconds: 1, shortWaitSeconds: 1, missionWallSeconds: 5 },
  phases: [
    {
      id: "read",
      trigger: { kind: "message", text: "read the fixture" },
      checkpoints: [{ name: "answered", type: "run_status", in: ["succeeded"] }],
    },
  ],
  final: [{ name: "no side effect", type: "no_unexpected_changes", allowed: [] }],
});
const observation: RunObservation = {
  runId: "run_phase",
  status: "succeeded",
  attempt: 1,
  attempts: [],
  coverage: "complete",
  usageReceipts: [],
  recordedConfig: {},
  context: null,
  tokens: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 },
  costUsd: 0.2,
  toolCalls: 0,
  toolErrors: 0,
  l2Calls: 0,
  events: [],
  ledgerContiguous: true,
};

describe("runner persists incomplete background accounting", () => {
  it.each(["background detail failure", "inventory failure"])(
    "keeps totals unknown after %s",
    async (failure) => {
      const state = new GoldenSiteState().view();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string) => new Response(JSON.stringify(url.endsWith("/log") ? [] : state)),
        ),
      );
      // The fake supplies only the Stack/RunView fields used by this orchestration path. No SDK,
      // Gateway listener, real HTTP request, Docker process or model participates in this test.
      const run = {
        id: observation.runId,
        status: "succeeded",
        attempt: 1,
        botId: "bot_test",
      } as unknown as RunView;
      const stack = {
        config: { defaultModel: "test", cheapModel: "test" },
        workspace: { id: "ws_test" },
        siteUrl: "http://fixture.test",
        api: async () => ({ status: 200, json: {} }),
        app: {
          deskmates: {
            ctx: { runs: { list: () => [run] }, bots: { get: () => ({ workspaceId: "ws_test" }) } },
            scheduler: { cancel: vi.fn() },
          },
        },
        docker: { client: { request: async () => ({ status: 200, body: "{}" }) } },
        handle: { providerRef: "test" },
      } as unknown as Stack;
      vi.mocked(postMessage).mockResolvedValue({ run } as Awaited<ReturnType<typeof postMessage>>);
      vi.mocked(getRun).mockResolvedValue({ run, usage: [] });
      const snapshot: DeploymentObservation =
        failure === "background detail failure"
          ? {
              runs: [observation],
              errors: [{ runId: "run_background", error: "GET failed" }],
              inventoryComplete: true,
            }
          : {
              runs: [observation],
              errors: [],
              inventoryComplete: false,
              inventoryError: "inventory page failed",
            };
      vi.mocked(observeDeployment).mockResolvedValue(snapshot);
      const persist = vi.fn();
      const report = await runMission({
        mission: parseMission(specText),
        specText,
        stack,
        repeat: 1,
        arm: "test",
        imageId: "test",
        egressImageId: "test",
        persist,
      });
      expect(postMessage).toHaveBeenCalledOnce();
      expect(report.outcome).toBe("unknown");
      expect(report.totals).toMatchObject({
        costUsd: null,
        tokens: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
        },
      });
      if (failure === "background detail failure")
        expect(report.totals).toMatchObject({
          logicalRuns: 2,
          knownLogicalRuns: 2,
          unobservedRunIds: ["run_background"],
        });
      else
        expect(report.totals).toMatchObject({
          logicalRuns: null,
          knownLogicalRuns: 1,
          inventoryComplete: false,
        });
      expect(persist.mock.calls.at(-1)?.[0].totals).toEqual(report.totals);
    },
  );
});
