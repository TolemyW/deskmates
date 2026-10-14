import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { manageBotFile, manageMemory } from "./memory-file.js";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskmates-memory-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it("reads, conditionally edits, clears and detects an intervening writer", () => {
  const initial = manageMemory(root, { botName: "nova", op: "read" });
  const saved = manageMemory(root, {
    botName: "nova",
    op: "write",
    body: "Check invoices.",
    expectedVersion: initial.version,
  });
  expect(manageMemory(root, { botName: "nova", op: "read" })).toEqual(saved);
  expect(() =>
    manageMemory(root, {
      botName: "nova",
      op: "write",
      body: "stale",
      expectedVersion: initial.version,
    }),
  ).toThrow("changed");
  expect(
    manageMemory(root, { botName: "nova", op: "write", body: "", expectedVersion: saved.version }),
  ).toEqual(initial);
});
it("rejects traversal, linked homes and linked memory files", () => {
  expect(() => manageMemory(root, { botName: "../x", op: "read" })).toThrow("Invalid");
  mkdirSync(join(root, "actual"));
  symlinkSync(join(root, "actual"), join(root, "linked"));
  expect(() => manageMemory(root, { botName: "linked", op: "read" })).toThrow("Unsafe");
  writeFileSync(join(root, "private"), "secret");
  symlinkSync(join(root, "private"), join(root, "actual", "MEMORY.md"));
  expect(() => manageMemory(root, { botName: "actual", op: "read" })).toThrow();
});
it("rejects oversized writes and oversized on-disk memory", () => {
  const initial = manageMemory(root, { botName: "nova", op: "read" });
  mkdirSync(join(root, "nova"));
  expect(() =>
    manageMemory(root, {
      botName: "nova",
      op: "write",
      body: "x".repeat(65537),
      expectedVersion: initial.version,
    }),
  ).toThrow("Invalid");
  writeFileSync(join(root, "nova", "MEMORY.md"), "x".repeat(65537));
  expect(() => manageMemory(root, { botName: "nova", op: "read" })).toThrow("65536");
});
it("reads and writes SOUL.md without allowing arbitrary filenames", () => {
  const initial = manageBotFile(root, { botName: "nova", fileName: "SOUL.md", op: "read" });
  const saved = manageBotFile(root, {
    botName: "nova",
    fileName: "SOUL.md",
    op: "write",
    body: "You are Nova.",
    expectedVersion: initial.version,
  });
  expect(manageBotFile(root, { botName: "nova", fileName: "SOUL.md", op: "read" })).toEqual(saved);
  expect(() =>
    manageBotFile(root, { botName: "nova", fileName: "settings.json", op: "read" }),
  ).toThrow("Invalid");
});
