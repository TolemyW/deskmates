// T0 wire golden for the trash API: every method's exact request and how its answer, a 401
// and an error body surface. `__golden__/api.golden.txt` is the contract; regenerate it with
// `vitest -u` only for an intended wire change. Harness: `src/platform/http-golden.ts`.

import { describe, expect, it } from "vitest";
import { BOT, type GoldenCases, WS, wireGolden } from "../../platform/http-golden.js";
import { type TrashApi, createTrashApi } from "./api.js";

const CASES: GoldenCases<TrashApi> = {
  listTrash: (a) => a.listTrash(),
  permanentlyDeleteBot: (a) => a.permanentlyDeleteBot(BOT, "Ada"),
  permanentlyDeleteWorkspace: (a) => a.permanentlyDeleteWorkspace(WS, "Ops"),
  restoreBot: (a) => a.restoreBot(BOT),
  restoreWorkspace: (a) => a.restoreWorkspace(WS),
};

describe("trash API wire golden", () => {
  it("pins every method's request and answer, and its failure surfaces", async () => {
    await expect(await wireGolden(createTrashApi, CASES)).toMatchFileSnapshot(
      "./__golden__/api.golden.txt",
    );
  });
});
