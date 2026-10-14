// An in-browser Gateway for the standalone demo: the operator routes the UI calls, backed by
// in-memory records and a scripted three-bot team. It exists so someone can try the product
// surface without Docker, a model or a Gateway. It is not a test double for the Gateway's
// behaviour (the rules it approximates, routing, caps and approvals, live in packages/gateway),
// and nothing in the operator UI imports it except the demo entry.
//
// This class is a facade. Shared records and helpers are in state.ts, the scripted team in
// team.ts, the core seed in core-seed.ts, and each feature's routes and seed data in
// `src/features/<feature>/demo.ts`, found by features.ts.

import { DEMO_FEATURES } from "./features.js";
import type { Result } from "./result.js";
import { routeDemoRequest } from "./router.js";
import { seedDemo } from "./seed.js";
import { type CostAlertFixture, DemoState, type Emit } from "./state.js";

export type { CostAlertFixture } from "./state.js";

export class MockGateway {
  private readonly state: DemoState;

  constructor(emit: Emit, costAlertFixture: CostAlertFixture = "empty") {
    this.state = new DemoState(emit, costAlertFixture);
    seedDemo(this.state, DEMO_FEATURES);
  }

  async handle(method: string, fullPath: string, body: unknown): Promise<Result> {
    return routeDemoRequest(DEMO_FEATURES, this.state, method, fullPath, body);
  }
}
