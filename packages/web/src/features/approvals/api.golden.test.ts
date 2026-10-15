// T0 wire golden for the approvals API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { APR, type GoldenCases, THR, WS, wireGolden } from "../../platform/http-golden.js";
import { type ApprovalsApi, createApprovalsApi } from "./api.js";

const CASES: GoldenCases<ApprovalsApi> = {
  decideApproval: (a) => a.decideApproval(APR, "allow_once", undefined),
  getApproval: (a) => a.getApproval(APR),
  getAutoApproval: (a) => a.getAutoApproval(WS),
  listApprovals: (a) => a.listApprovals({ status: "pending", threadId: THR }),
  listPendingApprovalsPage: (a) => a.listPendingApprovalsPage({ cursor: "c/1", limit: 50 }),
  setApprovalExpiry: (a) => a.setApprovalExpiry(WS, 30),
  setApprovalMode: (a) => a.setApprovalMode(WS, "approve_all"),
};

describe("approvals API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createApprovalsApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
