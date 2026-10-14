// The shape of one feature's demo module, `src/features/<feature>/demo.ts`: the operator routes it
// answers and the seed data it adds. The demo Gateway discovers these modules (features.ts); a
// new feature adds its own file and edits nothing in src/demo.

import type { BotDefinition, Workspace } from "@deskmates/contracts";
import type { Result } from "./result.js";
import type { DemoState } from "./state.js";

/** One operator request as a feature's route handler sees it. */
export interface DemoRequest {
  method: string;
  /** The URL path without the query, e.g. `/api/threads/thr_0001/messages`. */
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, `{}` when there is none. */
  body: Record<string, unknown>;
  /** `path.match(re)`. */
  match(re: RegExp): RegExpMatchArray | null;
}

/**
 * Answers the requests this feature owns and returns `undefined` for every other one. Paths are
 * disjoint between features (`features.test.ts` checks it), so the order features are tried in
 * does not change an answer; inside one handler the checks run top to bottom.
 */
export type DemoRoute = (
  req: DemoRequest,
  state: DemoState,
) => Result | Promise<Result> | undefined;

/** What the core seed created and feature seeds attach to: the ops team in `galaxy-ops`. */
export interface DemoSeedContext {
  /** The seed's clock; every seeded timestamp is relative to it. */
  now: number;
  ws: Workspace;
  chief: BotDefinition;
  researcher: BotDefinition;
  qa: BotDefinition;
}

/**
 * When a feature's seed runs. Ids come from one shared counter, so the phase is part of the
 * data: `team` runs after the core seed created `galaxy-ops` and its three bots and before the
 * chat history; `history` runs after the history and the other workspaces. Within a phase,
 * features seed in the order of their directory names.
 */
export type DemoSeedPhase = "team" | "history";

export interface DemoFeature {
  route?: DemoRoute;
  seed?: { after: DemoSeedPhase; run(state: DemoState, ctx: DemoSeedContext): void };
}
