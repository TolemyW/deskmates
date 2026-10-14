// T0: the lexical half of the ADR-0014 decision 2 path policy, shared by the Gateway (before any
// exec) and the sidecar's `file-read` command (before `realpath`).

import { describe, expect, it } from "vitest";
import { workspaceFileRoot } from "./workspace-file.js";

describe("workspaceFileRoot", () => {
  const bots = ["nova", "atlas"];
  it.each<[string, string | undefined]>([
    ["/work/a.md", "/work"],
    ["/work/sub/dir/report-1_final.csv", "/work"],
    ["/home/nova/out.csv", "/home/nova"],
    ["/home/atlas/.cache/x", "/home/atlas"],
    ["/work/./a.md", "/work"],
    ["/profile/Cookies", undefined],
    ["/work/../profile/x", undefined],
    ["/work/..", undefined],
    ["/etc/passwd", undefined],
    ["/home/other-workspace-bot/x", undefined],
    ["/home/nova", undefined],
    ["/home/nova/", undefined],
    ["/work/", undefined],
    ["/work", undefined],
    ["work/a.md", undefined],
    ["/work/报告，最终.md", undefined],
    ["/work/a b.md", undefined],
    ["/work/a;rm -rf.md", undefined],
    ["/work/$(id)", undefined],
    ["/workspace/a.md", undefined],
    ["", undefined],
  ])("%s -> %s", (path, root) => {
    expect(workspaceFileRoot(path, bots)).toBe(root);
  });

  it("ignores bot names outside the bot-name charset", () => {
    expect(workspaceFileRoot("/home/../x", [".."])).toBeUndefined();
    expect(workspaceFileRoot("/home/a.b/x", ["a.b"])).toBeUndefined();
  });
});
