// The manifest.json the model A/B launcher (spikes/m2-model-ab/run.mjs) writes before the test
// starts: what source, images, models and knobs the campaign ran on. Pure, so it is tested under
// `npm test`; the launcher gathers the inputs from git and docker. Typed by the .d.mts beside it.

import { requireImageId } from "./image-id.mjs";
import { readAbConfig } from "./m2-model-ab.mjs";

/** The foundation knobs the A/B test applies (support/m2-foundation.ts). */
const MAX_TURNS = 8;
const RUN_TIMEOUT_SECONDS = 180;
const BROWSER_SNAPSHOT_MODE = "explicit-v1";

/**
 * @param {{
 *   revision: string; workingTreeStatus: string;
 *   image: string; imageId: string; egressImage: string; egressImageId: string;
 *   modelA: string; modelB: string; rounds: number; defaultModel: string; endpointOrigin: string;
 *   fixtureSha256: Record<string, string>; startedAt: string;
 * }} input
 */
export function buildAbManifest(input) {
  // Same rules as the test: both ids named (never DEFAULT_MODEL in their place), rounds in range.
  const { modelA, modelB, rounds } = readAbConfig({
    M2_AB_MODEL_A: input.modelA,
    M2_AB_MODEL_B: input.modelB,
    M2_AB_ROUNDS: String(input.rounds),
  });
  if (!input.revision) throw new Error("revision is required");
  return {
    revision: input.revision,
    // Recorded verbatim: a dirty tree is evidence about the run, not something to hide.
    workingTreeStatus: input.workingTreeStatus,
    image: input.image,
    imageId: requireImageId(input.imageId, "imageId"),
    egressImage: input.egressImage,
    egressImageId: requireImageId(input.egressImageId, "egressImageId"),
    rounds,
    roundOrder: "interleaved",
    arms: {
      A: { model: modelA, cheapModel: modelA },
      B: { model: modelB, cheapModel: modelB },
    },
    // The Gateway's DEFAULT_MODEL; no arm bot runs on it unless it equals that arm's model.
    defaultModel: input.defaultModel,
    endpointOrigin: input.endpointOrigin,
    fixtureSha256: input.fixtureSha256,
    maxTurns: MAX_TURNS,
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    browserSnapshotMode: BROWSER_SNAPSHOT_MODE,
    startedAt: input.startedAt,
  };
}
