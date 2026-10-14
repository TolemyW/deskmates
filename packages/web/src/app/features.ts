// Every feature of the operator UI, found with `import.meta.glob` (issue #53): the shell builds
// its navigation and picks the screen for a route from this list and nothing else.

import type { Feature, NavEntry } from "./feature.js";
import { NAV_GROUPS } from "./feature.js";
import type { Route, RouteName } from "./routes.js";

const modules = import.meta.glob<Feature>("../features/*/feature.tsx", {
  eager: true,
  import: "feature",
});

/** `../features/<feature>/feature.tsx` -> `<feature>`. */
function featureFolder(path: string): string {
  return path.split("/").at(-2) ?? path;
}

/** Feature folder name -> feature, in folder name order. */
export const FEATURES: ReadonlyMap<string, Feature> = new Map(
  Object.entries(modules)
    .map(([path, feature]): [string, Feature] => [featureFolder(path), feature])
    .sort(([a], [b]) => a.localeCompare(b)),
);

const byRoute = new Map<RouteName, Feature>();
for (const [folder, feature] of FEATURES)
  for (const name of Object.keys(feature.routes.screens) as RouteName[]) {
    if (byRoute.has(name)) throw new Error(`route ${name} is rendered by two features (${folder})`);
    byRoute.set(name, feature);
  }

/** The feature that renders a route; undefined for the shell's own invitation route. */
export function featureFor(route: Route): Feature | undefined {
  return byRoute.get(route.name);
}

/** The navigation entries of each sidebar group, in order. */
export function navigationGroups(): Array<{
  group: (typeof NAV_GROUPS)[number];
  entries: Array<{ folder: string; nav: NavEntry; feature: Feature }>;
}> {
  return NAV_GROUPS.map((group) => ({
    group,
    entries: [...FEATURES]
      .flatMap(([folder, feature]) =>
        feature.nav?.group === group ? [{ folder, nav: feature.nav, feature }] : [],
      )
      .sort((a, b) => a.nav.order - b.nav.order || a.folder.localeCompare(b.folder)),
  }));
}

/** The features whose routes open in the detail drawer. */
export function drawerFeatures(): Array<[string, Feature]> {
  return [...FEATURES].filter(([, feature]) => feature.drawer !== undefined);
}
