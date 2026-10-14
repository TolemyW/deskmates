import { describe, expect, it } from "vitest";
import { buildAbManifest } from "./m2-model-ab-manifest.mjs";

const WS_ID = `sha256:${"a".repeat(64)}`;
const EGRESS_ID = `sha256:${"b".repeat(64)}`;

const input = {
  revision: "1dc3b85",
  workingTreeStatus: "",
  image: WS_ID,
  imageId: WS_ID,
  egressImage: "deskmates/egress-proxy:dev",
  egressImageId: EGRESS_ID,
  modelA: "glm-5.3",
  modelB: "deepseek-v4.1-flash",
  rounds: 5,
  defaultModel: "glm-5.3",
  endpointOrigin: "https://models.example",
  fixtureSha256: { "acceptance/m2-model-ab.acceptance.test.ts": "c".repeat(64) },
  startedAt: "2026-09-29T00:00:00.000Z",
};

describe("buildAbManifest", () => {
  it("records both model ids, the revision, the tree status, both image ids and the round count", () => {
    const manifest = buildAbManifest(input);
    expect(manifest).toMatchObject({
      revision: "1dc3b85",
      workingTreeStatus: "",
      imageId: WS_ID,
      egressImageId: EGRESS_ID,
      rounds: 5,
      arms: {
        A: { model: "glm-5.3", cheapModel: "glm-5.3" },
        B: { model: "deepseek-v4.1-flash", cheapModel: "deepseek-v4.1-flash" },
      },
      roundOrder: "interleaved",
      maxTurns: 8,
      runTimeoutSeconds: 180,
      browserSnapshotMode: "explicit-v1",
    });
  });

  it("keeps a dirty working tree visible rather than dropping it", () => {
    expect(buildAbManifest({ ...input, workingTreeStatus: " M x.ts" }).workingTreeStatus).toBe(
      " M x.ts",
    );
  });

  it("refuses a manifest without both model ids", () => {
    expect(() => buildAbManifest({ ...input, modelB: "" })).toThrow(/M2_AB_MODEL_B/);
  });

  it("refuses image tags where an image ID is required", () => {
    expect(() => buildAbManifest({ ...input, imageId: "deskmates/workspace:dev" })).toThrow(
      /imageId must be pinned by Docker image ID/,
    );
    expect(() => buildAbManifest({ ...input, egressImageId: "" })).toThrow(/egressImageId/);
  });

  it("refuses a missing revision or an invalid round count", () => {
    expect(() => buildAbManifest({ ...input, revision: "" })).toThrow(/revision/);
    expect(() => buildAbManifest({ ...input, rounds: 0 })).toThrow(/M2_AB_ROUNDS/);
  });
});
