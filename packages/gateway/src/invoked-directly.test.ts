import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokedDirectly } from "./invoked-directly.js";

let root: string;
let entry: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "invoked-directly-"));
  mkdirSync(join(root, "releases", "v1", "dist"), { recursive: true });
  entry = join(root, "releases", "v1", "dist", "index.js");
  writeFileSync(entry, "");
  symlinkSync(join("releases", "v1"), join(root, "current"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("invokedDirectly", () => {
  it("is true when argv[1] reaches the module through a symlinked release directory", () => {
    // What the stable deployment's unit runs: node .../current/dist/index.js, while Node reports
    // the module's real path in import.meta.url.
    const viaLink = join(root, "current", "dist", "index.js");
    expect(invokedDirectly(viaLink, pathToFileURL(entry).href)).toBe(true);
  });

  it("is true for the plain path", () => {
    expect(invokedDirectly(entry, pathToFileURL(entry).href)).toBe(true);
  });

  it("is false when another module is the entry point, or there is none", () => {
    const other = join(root, "releases", "v1", "dist", "other.js");
    writeFileSync(other, "");
    expect(invokedDirectly(other, pathToFileURL(entry).href)).toBe(false);
    expect(invokedDirectly(undefined, pathToFileURL(entry).href)).toBe(false);
    expect(invokedDirectly(join(root, "missing.js"), pathToFileURL(entry).href)).toBe(false);
  });
});
