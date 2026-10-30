// T0, issue #53: the files every feature used to append to stay small. Each budget sits modestly
// above the file's size when the hotspot was split; a file that crosses it is growing back into a
// shared append point. Put the new code in the feature or domain that owns it instead (AGENTS.md,
// "Parallel development: no shared append points"). Raise a budget only with a reason in review.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BUDGETS = {
  // Web: bootstrap and composition only; features live in src/features/<feature>/.
  "packages/web/src/app.tsx": 20,
  "packages/web/src/app/authenticated-app.tsx": 200,
  // Raised 2026-10-18 by three for the run-stats feature's lines (ADR-0050).
  // Raised by three more 2026-10-18 for the task-kinds domain's sorted lines (ADR-0021 amendment 4).
  // Raised by three more 2026-10-18 for the web search domain (ADR-0049).
  "packages/web/src/api/client.ts": 109,
  "packages/web/src/demo/mock-gateway.ts": 50,
  "packages/web/src/i18n/catalogs.ts": 50,
  // Global stylesheets: feature styles go in the feature's own stylesheet.
  "packages/web/src/app.css": 1550,
  "packages/web/src/design-refresh.css": 320,
  "packages/web/src/resources.css": 340,
  "packages/web/src/typography.css": 90,
  // Gateway: policies live in api/route-policies/<domain>.ts, readers in config/<domain>.ts.
  // route-policy.ts and routes.ts hold sorted lists that grow by one line (plus an import) per
  // new domain; their budgets leave room for that and nothing else. context.ts grows by a field
  // and a constructor call per service; the follow-up is per-domain sub-contexts (ctx.budget.*,
  // ctx.tasks.*), which removes that append point. Raised 2026-10-13 for budget, board, rounds,
  // model jobs and Activity summaries; routes.ts raised again 2026-10-17 for the analytics relay
  // and desktop tools domains (ADR-0046 amendment 1, ADR-0048); route-policy.ts raised by two
  // 2026-10-17 for the host-resources domain (ADR-0006 amendment 5) and by two more for the vault
  // domain (ADR-0045); by two more 2026-10-18 for the run-stats domain (ADR-0050), and by two
  // more for the task-kinds domain (ADR-0021 amendment 4), and by two more for the web search
  // domain (ADR-0049).
  "packages/gateway/src/api/route-policy.ts": 250,
  // routes.ts raised by two 2026-10-18 for the web search domain (ADR-0049).
  "packages/gateway/src/api/routes.ts": 252,
  "packages/gateway/src/context.ts": 360,
  "packages/gateway/src/config.ts": 80,
};

const lines = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").split("\n").length - 1;

describe("former hotspots", () => {
  for (const [path, budget] of Object.entries(BUDGETS))
    it(`${path} stays within ${budget} lines`, () => {
      expect(
        lines(path),
        `${path} grew past its budget; move the addition into the feature or domain that owns it (AGENTS.md, "Parallel development: no shared append points")`,
      ).toBeLessThanOrEqual(budget);
    });
});
