// T1: vision evidence is keyed by the model's own upstream (ADR-0039 decision 6). A model on
// `default` keeps the pre-registry key (hash of MODEL_BASE_URL), so existing probe rows stay
// current; a model on another upstream keys on that upstream's URL.

import type { WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../test-support/harness.js";
import { endpointSha256 } from "./vision-probes.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("vision probe key per upstream", () => {
  it("hashes the serving upstream's base URL", async () => {
    h = await startHarness({
      modelBaseUrl: "http://main.test",
      modelUpstreams: [
        {
          id: "vl",
          baseUrl: "http://vl.test:8005",
          models: ["local-vl"],
          protocol: "anthropic",
        },
      ],
    });
    const { workspace, bot } = await h.seed();
    const vision = h.app.deskmates.ctx.modelJobs.vision;
    for (const model of ["test-model-default", "local-vl"]) {
      vision.queue({
        workspaceId: workspace.id as WorkspaceId,
        model,
        trigger: "retry",
        requestedBy: "test",
        host: bot,
      });
    }
    const rows = h.app.deskmates.ctx.db
      .prepare(
        "SELECT model, endpoint_sha256 FROM model_capability_probes WHERE workspace_id = ? ORDER BY model",
      )
      .all(workspace.id) as { model: string; endpoint_sha256: string }[];
    expect(rows).toEqual([
      { model: "local-vl", endpoint_sha256: endpointSha256("http://vl.test:8005") },
      { model: "test-model-default", endpoint_sha256: endpointSha256("http://main.test") },
    ]);
    // Each model's current result reads its own key.
    expect(vision.current(workspace.id as WorkspaceId, "local-vl").id).not.toBeNull();
  });
});
