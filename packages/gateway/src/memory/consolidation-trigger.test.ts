import { expect, it } from "vitest";
import { shouldConsolidate } from "./consolidation.js";

const now = new Date("2026-09-30T12:00:00.000Z");
const ready = { episodes: 3, candidates: 0, interactiveRunning: false };

it("requires a counter threshold, ten quiet minutes and a full-day cooldown", () => {
  expect(shouldConsolidate({ ...ready, episodes: 2 }, now)).toBe(false);
  expect(shouldConsolidate({ ...ready, episodes: 0, candidates: 10 }, now)).toBe(true);
  expect(shouldConsolidate({ ...ready, interactiveRunning: true }, now)).toBe(false);
  expect(
    shouldConsolidate({ ...ready, lastInteractiveFinishedAt: "2026-09-30T11:51:00.000Z" }, now),
  ).toBe(false);
  expect(
    shouldConsolidate({ ...ready, lastInteractiveFinishedAt: "2026-09-30T11:50:00.000Z" }, now),
  ).toBe(true);
  expect(
    shouldConsolidate({ ...ready, lastConsolidationAt: "2026-09-29T12:01:00.000Z" }, now),
  ).toBe(false);
  expect(
    shouldConsolidate({ ...ready, lastConsolidationAt: "2026-09-29T12:00:00.000Z" }, now),
  ).toBe(true);
});
