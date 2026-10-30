// T0 wire golden for the Vault API (ADR-0045 decision 2): every method's exact request and how
// its answer, a 401 and an error body surface. A value goes out only in the body of a create or a
// replacement, never in a URL. Regenerate with `vitest -u` only for an intended wire change.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type VaultApi, createVaultApi } from "./api.js";

const CASES: GoldenCases<VaultApi> = {
  createVaultEntry: (a) =>
    a.createVaultEntry(WS, {
      name: "Console",
      type: "browser_login",
      targetOrigin: "https://console.example.test",
      username: "synthetic-user",
      password: "synthetic-password",
    }),
  deleteVaultEntry: (a) => a.deleteVaultEntry(WS, "vlt/1", 3),
  getWorkspaceVault: (a) => a.getWorkspaceVault(WS),
  replaceVaultValue: (a) =>
    a.replaceVaultValue(WS, "vlt/1", { expectedRevision: 2, password: "synthetic-new" }),
  setVaultRequests: (a) =>
    a.setVaultRequests(WS, "vlt/1", {
      expectedRevision: 2,
      requests: [
        {
          name: "List items",
          method: "GET",
          path: "/v1/items",
          params: [{ name: "q", in: "query", type: "string" }],
          header: { scheme: "bearer" },
          effect: "read",
        },
      ],
    }),
  updateVaultEntry: (a) => a.updateVaultEntry(WS, "vlt/1", { expectedRevision: 2, enabled: false }),
};

describe("vault API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createVaultApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
