// T0 wire golden for the computer API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type ComputerApi, createComputerApi } from "./api.js";

const CASES: GoldenCases<ComputerApi> = {
  closeScreenAccess: (a) => a.closeScreenAccess("acc/1"),
  getBotScreen: (a) => a.getBotScreen(BOT),
  getWorkspace: (a) => a.getWorkspace(WS),
  handBack: (a) => a.handBack(WS),
  openTakeoverScreen: (a) => a.openTakeoverScreen(WS),
  screenAccess: (a) => a.screenAccess(BOT, "control"),
  startBotScreen: (a) => a.startBotScreen(BOT),
  takeOver: (a) => a.takeOver(WS, "user_1"),
};

describe("computer API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createComputerApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
