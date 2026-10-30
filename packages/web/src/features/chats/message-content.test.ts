// @vitest-environment node
import { expect, it } from "vitest";
import { FOLD_MIN_HIDDEN, worthFolding } from "./message-content.js";

const body = `${"a".repeat(300)}\n${"b".repeat(100)}`;
const excerpt = "a".repeat(240);

it("folds only when the excerpt hides more than a fifth of the rendered height", () => {
  expect(FOLD_MIN_HIDDEN).toBe(0.2);
  expect(worthFolding({ excerpt, body }, { excerpt: 100, full: 200 })).toBe(true);
  expect(worthFolding({ excerpt, body }, { excerpt: 80, full: 100 })).toBe(false);
  expect(worthFolding({ excerpt, body }, { excerpt: 85, full: 100 })).toBe(false);
  expect(worthFolding({ excerpt, body }, { excerpt: 79, full: 100 })).toBe(true);
});

it("lets the text decide without layout: characters or lines hidden", () => {
  expect(worthFolding({ excerpt, body })).toBe(true);
  expect(worthFolding({ excerpt, body }, { excerpt: 0, full: 0 })).toBe(true);
  const short = "x".repeat(380);
  expect(worthFolding({ excerpt: "x".repeat(320), body: short })).toBe(false);
  const manyLines = Array.from({ length: 10 }, (_, i) => `${i}`).join("\n");
  expect(
    worthFolding({ excerpt: manyLines.split("\n").slice(0, 6).join("\n"), body: manyLines }),
  ).toBe(true);
});
