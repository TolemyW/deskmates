// T0 wire golden for the board API: every method's exact request and how its answer, a 401 and
// an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type BoardApi, createBoardApi } from "./api.js";

const CASES: GoldenCases<BoardApi> = {
  boardPostHistory: (a) => a.boardPostHistory(WS, "bp/1"),
  createBoardPost: (a) => a.createBoardPost(WS, { body: "Hello", clientRequestId: "req-1" }),
  editBoardPost: (a) => a.editBoardPost(WS, "bp/1", "Hello again"),
  listBoardPosts: (a) => a.listBoardPosts(WS, { before: "cur/1", limit: 20 }),
  moderateBoardPost: (a) => a.moderateBoardPost(WS, "bp/1", { hidden: true, reason: "spam" }),
  withdrawBoardPost: (a) => a.withdrawBoardPost(WS, "bp/1"),
};

describe("board API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createBoardApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
