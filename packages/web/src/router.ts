// Hash router with no dependency. The routes themselves live with their features: each
// `src/features/<feature>/route.ts` adds its routes to `RouteMap` (`src/app/routes.ts`) and
// exports their parser, href helpers and legacy redirects; `src/app/route-registry.ts` assembles
// them (issue #53). This module keeps the public router API: the `Route` type, `parseRoute`,
// `legacyRedirect`, the href helpers the screens import, and the location hooks.

import { useEffect, useState } from "react";
import { legacyRedirect, parseRoute } from "./app/route-registry.js";

export type { Route, RouteMap, RouteName } from "./app/routes.js";
export type { KnowledgeTab } from "./features/knowledge/route.js";
export { legacyRedirect, parseRoute } from "./app/route-registry.js";
export { approvalsHref } from "./features/approvals/route.js";
export { threadHref } from "./features/chats/route.js";
export { computerHref } from "./features/computer/route.js";
export { channelHref, contactHref, newContactHref } from "./features/contacts/route.js";
export { filesHref } from "./features/files/route.js";
export { knowledgeHref } from "./features/knowledge/route.js";
export { runHref } from "./features/runs/route.js";
export { skillsHref } from "./features/skills/route.js";
export { taskHref } from "./features/tasks/route.js";
export { trashHref } from "./features/trash/route.js";

import type { Route } from "./app/routes.js";

export function navigate(href: string): void {
  window.location.hash = href.startsWith("#") ? href.slice(1) : href;
}

/** Rewrites an old address in place, so the address bar and history show where the page lives. */
function redirectLegacyHash(): void {
  const next = legacyRedirect(window.location.hash);
  if (next === undefined) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${next}`,
  );
}

export function useHashRoute(): Route {
  return useHashLocation().route;
}

/** Keep the parsed route and its return address in the same navigation snapshot. */
export function useHashLocation(): { route: Route; hash: string } {
  const snapshot = () => {
    redirectLegacyHash();
    const hash = window.location.hash;
    return { route: parseRoute(hash), hash };
  };
  const [location, setLocation] = useState(snapshot);
  useEffect(() => {
    const onChange = (): void => {
      redirectLegacyHash();
      const hash = window.location.hash;
      setLocation({ route: parseRoute(hash), hash });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return location;
}
