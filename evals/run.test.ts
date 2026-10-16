// T0 (issue #11): `npm run evals` on an empty or missing trace set exits 0 and says so; with
// traces it hands every `.json` file, sorted, to the replay.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvals, traceFiles } from "./run.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "deskmates-evals-"));
  dirs.push(dir);
  return dir;
}

describe("npm run evals", () => {
  it("exits 0 with a clear message on an empty trace set", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, ".gitkeep"), "");
    const lines: string[] = [];
    expect(await runEvals(dir, (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toBe(`No replay traces in ${dir}; nothing to replay.`);
    expect(lines.join("\n")).toContain("npm run replay -- export");
  });

  it("treats a missing directory as an empty set", async () => {
    const dir = path.join(await tempDir(), "absent");
    expect(await traceFiles(dir)).toEqual([]);
    expect(await runEvals(dir, () => {})).toBe(0);
  });

  it("lists only JSON traces, sorted", async () => {
    const dir = await tempDir();
    for (const name of ["b.json", ".gitkeep", "a.json", "notes.md"])
      await writeFile(path.join(dir, name), "{}");
    expect(await traceFiles(dir)).toEqual([path.join(dir, "a.json"), path.join(dir, "b.json")]);
  });
});
