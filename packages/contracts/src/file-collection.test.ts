import { describe, expect, it } from "vitest";
import { fileKindOf, parseFileCollectionQuery, workspacePathTokens } from "./file-collection.js";

describe("fileKindOf", () => {
  it.each([
    ["/work/report.md", "documents"],
    ["/work/data.CSV", "documents"],
    ["/work/plan.pdf", "documents"],
    ["/home/nova/shot.png", "images"],
    ["/work/logo.svg", "images"],
    ["/work/site/index.html", "web"],
    ["/work/page.htm", "web"],
    ["/work/archive.tar.gz", "other"],
    ["/work/Makefile", "other"],
    ["/work/.env", "other"],
  ])("%s is %s", (path, kind) => {
    expect(fileKindOf(path)).toBe(kind);
  });
});

describe("workspacePathTokens", () => {
  it("finds the paths decision 5 links and nothing else", () => {
    expect(
      workspacePathTokens(
        "Wrote /work/a.md and /home/nova/out.csv. See /work/b.md，then ./work/c.md /tmp/work/d.md /work/ /work/../x",
      ),
    ).toEqual(["/work/a.md", "/home/nova/out.csv", "/work/b.md"]);
  });

  it("skips a quoted path that contains spaces", () => {
    expect(workspacePathTokens('Saved "/work/my report.md" and `/work/ok.md`')).toEqual([
      "/work/ok.md",
    ]);
  });
});

describe("parseFileCollectionQuery", () => {
  it("defaults to the first page of 25, every type and source", () => {
    expect(parseFileCollectionQuery({})).toEqual({
      ok: true,
      query: { offset: 0, limit: 25, type: "all", source: "all", q: "" },
    });
  });

  it("accepts every documented value", () => {
    expect(
      parseFileCollectionQuery({
        offset: "50",
        limit: "100",
        type: "images",
        source: "bot",
        q: "  Report ",
      }),
    ).toEqual({
      ok: true,
      query: { offset: 50, limit: 100, type: "images", source: "bot", q: "report" },
    });
  });

  it.each([
    [{ limit: "101" }],
    [{ limit: "0" }],
    [{ offset: "-1" }],
    [{ offset: "1.5" }],
    [{ type: "pdf" }],
    [{ source: "human" }],
    [{ q: "x".repeat(201) }],
    [{ q: ["a", "b"] }],
  ])("refuses %j", (raw) => {
    expect(parseFileCollectionQuery(raw).ok).toBe(false);
  });
});
