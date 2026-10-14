// T0: every T2 file is classified. `t2-smoke.list` names the files `npm run
// test:container:smoke` runs (and `stable.sh verify` runs for a patch tag); `t2-full-only.list`
// names the rest, each with a one-line reason. A new `*.container.test.ts` that is in neither
// list fails here, so adding a T2 file means deciding whether it gates patch releases.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));

interface Entry {
  path: string;
  reason: string;
  line: number;
}

/** Non-comment, non-blank lines: the first word is a repo-relative path, the rest a reason. */
function readList(name: string): Entry[] {
  return readFileSync(join(REPO, "acceptance", name), "utf8")
    .split("\n")
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => text !== "" && !text.startsWith("#"))
    .map(({ text, line }) => {
      const [path = "", ...rest] = text.split(/\s+/);
      return { path, reason: rest.join(" "), line };
    });
}

/** Every `*.container.test.ts` under acceptance/ and packages/, outside node_modules and dist. */
function containerTests(): string[] {
  const found: string[] = [];
  for (const root of ["acceptance", "packages"]) {
    for (const entry of readdirSync(join(REPO, root), { recursive: true, encoding: "utf8" })) {
      const parts = entry.split(sep);
      if (parts.includes("node_modules") || parts.includes("dist")) continue;
      if (entry.endsWith(".container.test.ts")) found.push(`${root}/${parts.join("/")}`);
    }
  }
  return found.sort();
}

const smoke = readList("t2-smoke.list");
const fullOnly = readList("t2-full-only.list");

describe("T2 smoke and full-only lists", () => {
  it("smoke is non-empty, one bare path per line, each an existing T2 file", () => {
    expect(smoke.length).toBeGreaterThan(0);
    for (const entry of smoke) {
      expect(entry.reason, `t2-smoke.list:${entry.line} carries only a path`).toBe("");
      expect(entry.path, `t2-smoke.list:${entry.line}`).toMatch(/\.container\.test\.ts$/);
      expect(existsSync(join(REPO, entry.path)), `${entry.path} exists`).toBe(true);
    }
  });

  it("full-only names existing T2 files, each with a reason", () => {
    for (const entry of fullOnly) {
      expect(entry.path, `t2-full-only.list:${entry.line}`).toMatch(/\.container\.test\.ts$/);
      expect(existsSync(join(REPO, entry.path)), `${entry.path} exists`).toBe(true);
      expect(entry.reason.length, `t2-full-only.list:${entry.line} needs a reason`).toBeGreaterThan(
        10,
      );
    }
  });

  it("classifies every T2 file exactly once", () => {
    const listed = [...smoke, ...fullOnly].map((entry) => entry.path);
    expect(
      listed.filter((path, i) => listed.indexOf(path) !== i),
      "listed twice",
    ).toEqual([]);
    const all = containerTests();
    expect(
      all.filter((path) => !listed.includes(path)),
      "unclassified: add to acceptance/t2-smoke.list or acceptance/t2-full-only.list",
    ).toEqual([]);
    expect(listed.filter((path) => !all.includes(path))).toEqual([]);
  });

  it("the smoke script runs exactly the smoke list", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:container:smoke"]).toContain("acceptance/t2-smoke.list");
  });
});
