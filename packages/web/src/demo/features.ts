// Every feature's demo module, found by file name: `src/features/<feature>/demo.ts` exporting
// `demo: DemoFeature`. Sorted by path, so routing and seeding order never depend on the bundler.
// The core routes (`/api/config`) come first.

import { coreDemo } from "./core-routes.js";
import type { DemoFeature } from "./feature.js";

const modules = import.meta.glob<{ demo: DemoFeature }>("../features/*/demo.ts", { eager: true });

/** The feature directory name of each discovered module, in order; for tests and debugging. */
export const DEMO_FEATURE_NAMES: readonly string[] = Object.keys(modules)
  .sort()
  .map((path) => path.split("/").at(-2) ?? path);

export const DEMO_FEATURES: readonly DemoFeature[] = [
  coreDemo,
  ...Object.keys(modules)
    .sort()
    .map((path) => (modules[path] as { demo: DemoFeature }).demo),
];
