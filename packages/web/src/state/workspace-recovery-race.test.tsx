// @vitest-environment jsdom
import type { Workspace } from "@deskmates/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../api/client.js";
import { FakeEventSource, installFakeEventSource, workspace } from "../test-support/fixtures.js";
import { WorkspaceScopeProvider, useWorkspaceScope } from "./workspace-scope.js";

beforeEach(() => {
  installFakeEventSource();
  localStorage.clear();
});
afterEach(cleanup);

describe("workspace recovery snapshot ordering", () => {
  for (const scenario of [
    "add",
    "update",
    "stream",
    "standalone-add",
    "standalone-update",
  ] as const) {
    const mode = scenario.replace("standalone-", "");
    const standalone = scenario.startsWith("standalone-");
    it(`preserves a newer ${scenario} while applying a delayed recovery snapshot`, async () => {
      let resolve!: (rows: Workspace[]) => void;
      let reads = 0;
      const api = createApiClient({
        fetch: async () => {
          const rows =
            ++reads === 1
              ? [workspace]
              : await new Promise<Workspace[]>((done) => {
                  resolve = done;
                });
          return Response.json({ workspaces: rows });
        },
      });
      const newer = {
        ...workspace,
        ...(mode === "add" ? { id: "ws_added" as Workspace["id"] } : {}),
        name: "Newer workspace",
        egressAllowlist: ["new.example.test"],
      };
      function Probe() {
        const scope = useWorkspaceScope(api);
        return (
          <>
            <button type="button" onClick={() => void scope.reload()}>
              Reload
            </button>
            <button
              type="button"
              onClick={() => (mode === "add" ? scope.add(newer) : scope.update(newer))}
            >
              Mutate
            </button>
            <p>{scope.current?.name}</p>
            <output>{JSON.stringify(scope.workspaces)}</output>
            {scope.current ? (
              <input key={scope.current.id} aria-label="Editor" defaultValue="" />
            ) : null}
          </>
        );
      }
      render(
        standalone ? (
          <Probe />
        ) : (
          <WorkspaceScopeProvider api={api}>
            <Probe />
          </WorkspaceScopeProvider>
        ),
      );
      await screen.findByText(workspace.name);
      fireEvent.click(screen.getByText("Reload"));
      if (mode === "stream")
        act(() =>
          FakeEventSource.forUrl("/api/events").emit({
            type: "workspace",
            workspaceId: newer.id,
            workspace: newer,
          }),
        );
      else fireEvent.click(screen.getByText("Mutate"));
      const editor = screen.getByRole("textbox", { name: "Editor" });
      fireEvent.change(editor, { target: { value: "Unsent editor text" } });
      const other = { ...workspace, id: "ws_other" as Workspace["id"], name: "Snapshot addition" };
      await act(async () => resolve([workspace, other]));
      expect(screen.getByText("Newer workspace")).toBeTruthy();
      expect(screen.getByRole("textbox", { name: "Editor" })).toBe(editor);
      expect((editor as HTMLInputElement).value).toBe("Unsent editor text");
      expect(screen.getByRole("status").textContent).toContain("new.example.test");
      expect(screen.getByRole("status").textContent).toContain("Snapshot addition");
      // A later authoritative read must still be able to remove rows: overlays live for
      // one request only, not forever, and must not restore access after revocation.
      fireEvent.click(screen.getByText("Reload"));
      await act(async () => resolve([workspace]));
      expect(screen.getByText(workspace.name)).toBeTruthy();
      expect(screen.getByRole("status").textContent).not.toContain("Newer workspace");
      expect(screen.getByRole("status").textContent).not.toContain("Snapshot addition");
    });
  }
});
