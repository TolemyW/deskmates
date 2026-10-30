// The demo features are found by file name, and no two of them claim the same request, so the
// order the router tries them in never changes an answer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_FEATURES, DEMO_FEATURE_NAMES } from "./features.js";
import { demoRequest } from "./router.js";
import { seedDemo } from "./seed.js";
import { DemoState } from "./state.js";

/** One path per route shape the demo answers; `x` and `y` stand for ids. */
const PROBES = [
  "/api/config",
  "/api/members",
  "/api/members/x",
  "/api/invitations",
  "/api/invitations/x",
  "/api/accounts",
  "/api/workspaces",
  "/api/workspaces/x",
  "/api/workspaces/x/tasks",
  "/api/workspaces/x/tasks/y",
  "/api/workspaces/x/tasks/y/accept",
  "/api/workspaces/x/takeover",
  "/api/workspaces/x/handback",
  "/api/workspaces/x/takeover/open-screen",
  "/api/workspaces/x/assets",
  "/api/workspaces/x/board",
  "/api/workspaces/x/board/y",
  "/api/workspaces/x/files",
  "/api/workspaces/x/memory",
  "/api/workspaces/x/memory/search",
  "/api/workspaces/x/skills",
  "/api/skills/x",
  "/api/skills/x/versions",
  "/api/skills/x/assign",
  "/api/skills/x/undo",
  "/api/skills/x/versions/1/confirm",
  "/api/bots",
  "/api/bots/x",
  "/api/bots/x/screen",
  "/api/bots/x/screen/start",
  "/api/bots/x/screen/access",
  "/api/screen-access/x/close",
  "/api/bots/x/soul",
  "/api/bots/x/memory",
  "/api/bots/x/memory/consolidate",
  "/api/bots/x/approval-rules",
  "/api/bots/x/private-chat",
  "/api/approval-rules/x",
  "/api/threads",
  "/api/threads/x",
  "/api/threads/x/activity",
  "/api/threads/x/members",
  "/api/threads/x/members/y",
  "/api/threads/x/messages",
  "/api/threads/x/close-task",
  "/api/runs",
  "/api/runs/x",
  "/api/runs/x/events",
  "/api/runs/x/context",
  "/api/runs/x/cancel",
  "/api/runs/x/continuation/decide",
  "/api/approvals",
  "/api/approvals/x",
  "/api/approvals/x/decide",
  "/api/costs",
  "/api/cost-alert-rules",
  "/api/cost-alert-rules/x",
  "/api/cost-alerts",
  "/api/cost-alerts/x/acknowledge",
  "/api/prices",
  "/api/knowledge",
  "/api/knowledge/x",
  "/api/knowledge/x/history",
  "/api/knowledge/proposals",
  "/api/knowledge/proposals/x/review",
  "/api/knowledge/versions/cleanup",
  "/api/memory-suggestions",
  "/api/memory-suggestions/x/review",
  "/api/memory/entries/x",
  "/api/memory/entries/x/versions",
  "/api/memory/entries/x/forget",
  "/api/integrations",
  "/api/integrations/catalog",
  "/api/integrations/providers",
  "/api/integrations/providers/x",
  "/api/integrations/workspaces/x/connections",
  "/api/integrations/workspaces/x/connections/api-key",
  "/api/integrations/workspaces/x/connections/oauth/start",
  "/api/integrations/workspaces/x/connections/y",
  "/api/connectors",
  "/api/channels",
  "/api/workspaces/x/channels",
  "/api/workspaces/x/channels/y/connect",
  "/api/workspaces/x/channels/y/commands/test",
  "/api/workspaces/x/channel-connections/y/commands/reconnect",
  "/api/workspaces/x/channel-connections/y/rebind",
  "/api/workspaces/x/channel-connections/y/blocks",
];

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

describe("demo features", () => {
  beforeEach(() => {
    // Claimed requests may start scripted runs; their timers never fire here.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are discovered from src/features/*/demo.ts in name order", () => {
    expect(DEMO_FEATURE_NAMES).toEqual([...DEMO_FEATURE_NAMES].sort());
    expect(DEMO_FEATURE_NAMES).toEqual(
      expect.arrayContaining(["approvals", "chats", "costs", "members", "tasks", "workspaces"]),
    );
    expect(DEMO_FEATURES).toHaveLength(DEMO_FEATURE_NAMES.length + 1);
  });

  for (const fixture of ["empty", "failure"] as const) {
    it(`claim disjoint requests (${fixture} cost alerts)`, () => {
      const state = new DemoState(() => {}, fixture);
      seedDemo(state, DEMO_FEATURES);
      const overlaps: string[] = [];
      for (const path of PROBES) {
        let claimedByAnyMethod = false;
        for (const method of METHODS) {
          const claimed = DEMO_FEATURES.filter(
            (feature) => feature.route?.(demoRequest(method, path, {}), state) !== undefined,
          );
          if (claimed.length > 1) overlaps.push(`${method} ${path}`);
          claimedByAnyMethod ||= claimed.length > 0;
        }
        expect(claimedByAnyMethod, path).toBe(true);
      }
      expect(overlaps).toEqual([]);
    });
  }
});
