// What the scripted upstream answers in a dry run of the web search comparison (protocol of
// 2026-10-18, §8, after amendment 1 A4 of the 2026-10-17 protocol). The executor sets the task
// about to run, the arm's search path and the fixture's origin as the container sees it; the
// script makes one search per hop of the task's reference path, through `web_search` where the
// run declares it and through the browser otherwise, then answers the task's value. Its pass rates
// measure the harness, never a model. Pure: a T1 test drives it with request bodies shaped like
// the CLI's.

import {
  type FakeTurn,
  type RecordedUpstreamRequest,
  assistantText,
} from "../../acceptance/support/fake-model-upstream.js";
import { toolNamed } from "../campaign/dry-run-script.js";
import type { WebSearchItem } from "./task-set.js";

type Body = RecordedUpstreamRequest["body"];

/** How many tool results the conversation already holds: the hops done so far. */
export function toolResultCount(body: Body): number {
  return (JSON.stringify(body?.messages ?? []).match(/"tool_result"/g) ?? []).length;
}

/** The browser MCP's navigation tool, as the CLI declares it. */
export const BROWSER_NAVIGATE = "browser_navigate";

export class WebSearchDryScript {
  current: WebSearchItem | undefined;
  /** The fixture origin the workspace container reaches. */
  origin = "";

  turn(body: Body): FakeTurn {
    const item = this.current;
    if (!item || !Array.isArray(body?.tools) || body.tools.length === 0)
      return { kind: "text", text: "dry run" };
    const hop = item.hops[toolResultCount(body)];
    if (hop) {
      const search = toolNamed(body, "web_search");
      if (search) return { kind: "tool_use", name: search, input: { query: hop.query } };
      const navigate = toolNamed(body, BROWSER_NAVIGATE);
      if (navigate)
        return {
          kind: "tool_use",
          name: navigate,
          input: { url: `${this.origin}/search?q=${encodeURIComponent(hop.query)}` },
        };
    }
    return { kind: "text", text: assistantText(`answer: ${item.answer.value}`) };
  }
}
