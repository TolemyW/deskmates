// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/client.js";
import { ConnectionsScreen } from "./connections.js";

const state = vi.hoisted(() => ({
  workspace: { id: "ws_a", name: "Alpha" },
  report: undefined as ((count: number) => void) | undefined,
}));
vi.mock("../../state/workspace-scope.js", () => ({
  useWorkspaceScope: () => ({ current: state.workspace }),
}));
vi.mock("./apps-tab.js", () => ({
  AppsTab: ({ onCount }: { onCount: (count: number) => void }) => {
    state.report = onCount;
    return null;
  },
}));
vi.mock("./channels-tab.js", () => ({ ChannelsTab: () => null }));
vi.mock("./databases-tab.js", () => ({ DatabasesTab: () => null }));
afterEach(cleanup);

it("keeps counts scoped even if the previous workspace reports after a switch", async () => {
  const props = { api: {} as ApiClient, tab: "apps" as const, onOpenGuide: () => {} };
  const view = render(<ConnectionsScreen {...props} />);
  const oldReport = state.report;
  const { act } = await import("@testing-library/react");
  act(() => oldReport?.(4));
  await screen.findByRole("link", { name: "Apps 4" });
  state.workspace = { id: "ws_b", name: "Beta" };
  view.rerender(<ConnectionsScreen {...props} />);
  expect(screen.getByRole("link", { name: "Apps" })).toBeInTheDocument();
  act(() => oldReport?.(9));
  expect(screen.queryByRole("link", { name: "Apps 9" })).toBeNull();
  act(() => state.report?.(2));
  await waitFor(() => expect(screen.getByRole("link", { name: "Apps 2" })).toBeInTheDocument());
});
