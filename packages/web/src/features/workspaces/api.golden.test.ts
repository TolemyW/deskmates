// T0 wire golden for the workspaces API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type WorkspacesApi, createWorkspacesApi } from "./api.js";

const CASES: GoldenCases<WorkspacesApi> = {
  archiveWorkspace: (a) => a.archiveWorkspace(WS),
  createWorkspace: (a) => a.createWorkspace({ name: "Ops", egressAllowlist: ["*"] }),
  listWorkspaceDirectory: (a) =>
    a.listWorkspaceDirectory({ q: "ops", filter: "pinned", role: "admin", offset: 20, limit: 20 }),
  listWorkspaces: (a) => a.listWorkspaces(),
  renameWorkspace: (a) => a.renameWorkspace(WS, "ops 2"),
  setWorkspacePinned: (a) => a.setWorkspacePinned(WS, true),
  updateWorkspaceEgress: (a) => a.updateWorkspaceEgress(WS, ["example.com"]),
};

describe("workspaces API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createWorkspacesApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
