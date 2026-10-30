// T0 (issue #39 item 5): relative task paths resolve against the run's work directory, `..` is
// normalised and cannot leave the allowed roots, and commit hashes and URLs are typed evidence.
import { describe, expect, it } from "vitest";
import { checkRunPath, evidenceKind, resolveRunPath, runWorkDir } from "./task-paths.js";

const nova = { workDir: "/work/bots/nova", botName: "nova", botNames: ["nova", "lyra"] };

describe("task paths", () => {
  it("starts per-bot runs in the bot directory and every other run in /work", () => {
    expect(runWorkDir("per-bot", "nova")).toBe("/work/bots/nova");
    expect(runWorkDir("shared", "nova")).toBe("/work");
    expect(runWorkDir(undefined, "nova")).toBe("/work");
  });

  it.each([
    ["web/app.py", "/work/bots/nova/web/app.py"],
    ["./web/../web/app.py", "/work/bots/nova/web/app.py"],
    ["../lyra/notes.md", "/work/bots/lyra/notes.md"],
    ["/work/a/../b.md", "/work/b.md"],
    ["out/", "/work/bots/nova/out/"],
    ["/../..", undefined],
  ])("resolves %s", (path, resolved) => {
    expect(resolveRunPath(path, "/work/bots/nova")).toBe(resolved);
  });

  it("accepts a resolved file under /work or a bot home", () => {
    expect(checkRunPath("web/app.py", nova)).toEqual({ path: "/work/bots/nova/web/app.py" });
    expect(checkRunPath("/home/nova/diary.md", nova)).toEqual({ path: "/home/nova/diary.md" });
    // ADR-0038 refuses writes only; naming a teammate's file is not a write.
    expect(checkRunPath("../lyra/notes.md", nova)).toEqual({ path: "/work/bots/lyra/notes.md" });
  });

  it.each([
    ["/tmp/x", "/tmp/x: outside /work/ and /home/nova/ of this workspace"],
    ["../../../etc/passwd", "(resolved to /etc/passwd): outside /work/"],
    ["../../../../../x", "climbs above / with .."],
    ["out/", "names a directory"],
    ["/work/", "names a directory"],
    ["/home/ghost/x", "outside /work/ and /home/nova/"],
    ["has space.md", "uses a character outside"],
  ])("refuses %s with a reason", (path, reason) => {
    const checked = checkRunPath(path, nova);
    expect(checked).toEqual({ error: expect.stringContaining(reason) });
  });

  it("tells the bot where to put a refused file", () => {
    expect(checkRunPath("/tmp/x", nova)).toEqual({
      error: expect.stringContaining("copy or write it under /work/bots/nova/"),
    });
  });

  it.each([
    ["9489f6a", "commit"],
    ["9489F6A0c0ffee9489f6a0c0ffee9489f6a0c0ff", "commit"],
    ["https://example.com/pull/1", "url"],
    ["http://example.com", "url"],
    ["948", "path"],
    ["web/app.py", "path"],
    ["ftp://example.com/x", "path"],
    ["https://", "path"],
  ])("classifies %s as %s", (entry, kind) => {
    expect(evidenceKind(entry)).toBe(kind);
  });
});
