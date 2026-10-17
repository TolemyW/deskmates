// T0: the file and shell tools the OpenAI runtime provides (ADR-0044 decision 4) behave like
// their Claude SDK namesakes on a real temporary directory.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinTools, globToRegExp } from "./builtin-tools.js";
import type { ToolSpec } from "./types.js";

let dir: string;
let tools: Map<string, ToolSpec>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deskmates-builtin-"));
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "alpha\nbeta\ngamma\n");
  await writeFile(join(dir, "src", "deep", "b.md"), "# title\nbeta here\n");
  await writeFile(join(dir, "notes.txt"), "one\ntwo\nthree\nfour\n");
  tools = new Map(builtinTools(dir).map((t) => [t.name, t]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (name: string, input: Record<string, unknown>) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(input);
};

describe("builtin tools", () => {
  it("offers the Claude SDK's names with its parameter names", () => {
    expect([...tools.keys()]).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LS"]);
    const read = tools.get("Read")?.parameters as { required: string[] };
    expect(read.required).toEqual(["file_path"]);
    const edit = tools.get("Edit")?.parameters as { required: string[] };
    expect(edit.required).toEqual(["file_path", "old_string", "new_string"]);
    const bash = tools.get("Bash")?.parameters as { required: string[] };
    expect(bash.required).toEqual(["command"]);
  });

  it("Read numbers lines and honours offset and limit, relative to the working directory", async () => {
    expect((await run("Read", { file_path: "notes.txt" })).text).toBe(
      "1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\t",
    );
    expect(
      (await run("Read", { file_path: join(dir, "notes.txt"), offset: 2, limit: 2 })).text,
    ).toBe("2\ttwo\n3\tthree");
    const missing = await run("Read", { file_path: "nope.txt" });
    expect(missing.isError).toBe(true);
  });

  it("Write creates and Edit replaces exactly one occurrence unless replace_all", async () => {
    expect(
      (await run("Write", { file_path: "new.txt", content: "x y x" })).isError,
    ).toBeUndefined();
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("x y x");
    const ambiguous = await run("Edit", { file_path: "new.txt", old_string: "x", new_string: "z" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/occurs 2 times/);
    await run("Edit", {
      file_path: "new.txt",
      old_string: "x",
      new_string: "z",
      replace_all: true,
    });
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("z y z");
    const absent = await run("Edit", { file_path: "new.txt", old_string: "q", new_string: "z" });
    expect(absent.isError).toBe(true);
  });

  it("Bash runs in the working directory, returns stdout and marks a non-zero exit", async () => {
    const ok = await run("Bash", { command: "pwd; echo out; echo err 1>&2" });
    expect(ok.isError).toBeUndefined();
    expect(ok.text).toContain("out");
    expect(ok.text).toContain("[stderr]\nerr");
    expect(ok.text.split("\n")[0]).toContain(dir.split("/").pop() ?? "");
    const failed = await run("Bash", { command: "exit 3" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("[exit 3]");
    const slow = await run("Bash", { command: "sleep 5", timeout: 1000 });
    expect(slow.isError).toBe(true);
    expect(slow.text).toContain("killed after 1000 ms");
  });

  it("Glob, Grep and LS search below the working directory", async () => {
    const globbed = await run("Glob", { pattern: "**/*.ts" });
    expect(globbed.text).toBe(join(dir, "src", "a.ts"));
    const grepped = await run("Grep", { pattern: "beta", path: "src" });
    expect(grepped.text.split("\n").sort()).toEqual([
      `${join(dir, "src", "a.ts")}:2: beta`,
      `${join(dir, "src", "deep", "b.md")}:2: beta here`,
    ]);
    const filtered = await run("Grep", { pattern: "beta", include: "*.md" });
    expect(filtered.text).toBe(`${join(dir, "src", "deep", "b.md")}:2: beta here`);
    expect((await run("LS", { path: "." })).text).toBe("notes.txt\nsrc/");
    expect((await run("Grep", { pattern: "zzz" })).text).toBe("No matches found");
  });

  it("globToRegExp handles ** and * and ?", () => {
    expect(globToRegExp("**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("src/?.md").test("src/b.md")).toBe(true);
    expect(globToRegExp("src/?.md").test("src/bb.md")).toBe(false);
  });
});
