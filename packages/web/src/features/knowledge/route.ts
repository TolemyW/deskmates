// Knowledge: `#/knowledge/<tab>`. Older addresses keep their meaning (issue #27): the former
// Shared computer page `#/workspace[/library|facts|settings]` and `#/memory` open the page their
// content moved to; `canonicalHref` names the current address.

import { defineRoutes } from "../../app/routes.js";

declare module "../../app/routes.js" {
  interface RouteMap {
    knowledge: { name: "knowledge"; tab: KnowledgeTab };
  }
}

/** Reviewed documents (the former Library) and learned observations (the former Facts). */
export type KnowledgeTab = "documents" | "observations";

function knowledgeTab(segment: string | undefined): KnowledgeTab {
  return segment === "observations" ? "observations" : "documents";
}

export function knowledgeHref(tab: KnowledgeTab = "documents"): string {
  return `#/knowledge/${tab}`;
}

export const routes = defineRoutes({
  screens: { knowledge: "workspaces" },
  segments: {
    knowledge: (rest) => ({ name: "knowledge", tab: knowledgeTab(rest) }),
    // The former Shared computer page: its bare address meant the Library tab, and an unknown
    // tab fell back to Library too. Skills sat below Facts, so a Facts link opens Observations.
    // Its Settings tab moved to Computer.
    workspace: (rest) => {
      const tab = rest ? decodeURIComponent(rest) : "library";
      if (tab === "settings") return { name: "computer" };
      return { name: "knowledge", tab: tab === "facts" ? "observations" : "documents" };
    },
    memory: () => ({ name: "knowledge", tab: "observations" }),
  },
  canonicalHref: (route) => knowledgeHref(route.tab),
});
