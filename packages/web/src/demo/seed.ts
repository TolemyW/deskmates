// Seeds a fresh demo state: the core team, then every feature seed of the `team` phase, the
// core history, then every feature seed of the `history` phase. Features run in the order they
// are given (features.ts sorts them by directory name), so the result, ids included, is the
// same on every load.

import { seedHistory, seedTeam } from "./core-seed.js";
import type { DemoFeature, DemoSeedPhase } from "./feature.js";
import type { DemoState } from "./state.js";

export function seedDemo(state: DemoState, features: readonly DemoFeature[], now = Date.now()) {
  const ctx = seedTeam(state, now);
  const phase = (after: DemoSeedPhase) => {
    for (const feature of features) if (feature.seed?.after === after) feature.seed.run(state, ctx);
  };
  phase("team");
  seedHistory(state, ctx);
  phase("history");
}
