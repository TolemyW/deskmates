// T0 wire golden for the network profiles API (ADR-0027 amendment 1): every method's exact
// request and how its answer, a 401 and an error body surface. Regenerate with `vitest -u` only
// for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type NetworkApi, createNetworkApi } from "./api.js";

const RULES = [
  { kind: "subnet" as const, cidr: "10.20.30.0/24", schemes: ["http" as const], ports: [23001] },
];

const CASES: GoldenCases<NetworkApi> = {
  createNetworkProfile: (a) => a.createNetworkProfile({ name: "Lab", rules: RULES }),
  deleteNetworkProfile: (a) => a.deleteNetworkProfile("netp/1"),
  getWorkspaceNetwork: (a) => a.getWorkspaceNetwork(WS),
  listNetworkProfiles: (a) => a.listNetworkProfiles(),
  replaceNetworkProfile: (a) =>
    a.replaceNetworkProfile(
      "netp/1",
      { name: "Lab", rules: RULES, expiresAt: "2026-10-20T00:00:00Z" },
      2,
    ),
  setWorkspaceNetworkProfiles: (a) =>
    a.setWorkspaceNetworkProfiles(WS, [{ profileId: "netp_1", expiresAt: "2026-10-20T00:00:00Z" }]),
};

describe("network API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createNetworkApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
