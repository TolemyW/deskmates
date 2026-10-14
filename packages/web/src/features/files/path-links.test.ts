// @vitest-environment jsdom
// T0: ADR-0014 decision 5. Absolute workspace paths in a message body become download links;
// the download fetches with the operator credential and saves through a temporary <a download>
// without ever navigating the page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../api/client.js";
import { WS_ID } from "../../test-support/fixtures.js";
import { type BodySegment, downloadWorkspaceFile, splitWorkspacePaths } from "./path-links.js";

const text = (t: string): BodySegment => ({ kind: "text", text: t });
const path = (p: string): BodySegment => ({ kind: "path", path: p });

describe("splitWorkspacePaths", () => {
  it.each<[string, BodySegment[]]>([
    ["/work/a.md", [path("/work/a.md")]],
    [
      "Saved to /work/out/report-1_final.csv",
      [text("Saved to "), path("/work/out/report-1_final.csv")],
    ],
    // A non-ASCII name ends the token right after the prefix, so nothing is linked.
    ["结果在 /work/报告.md", [text("结果在 /work/报告.md")]],
    ["见 /work/a.md，谢谢", [text("见 "), path("/work/a.md"), text("，谢谢")]],
    ["写入 /work/a.md。", [text("写入 "), path("/work/a.md"), text("。")]],
    ["（/work/a.md）", [text("（"), path("/work/a.md"), text("）")]],
    ["Done: /work/a.md.", [text("Done: "), path("/work/a.md"), text(".")]],
    ["/work/a.md and more", [path("/work/a.md"), text(" and more")]],
    ["/work/a.md\nnext line", [path("/work/a.md"), text("\nnext line")]],
    ["relative work/a.md is not linked", [text("relative work/a.md is not linked")]],
    ["./work/a.md is not linked", [text("./work/a.md is not linked")]],
    ["/tmp/work/a.md is not linked", [text("/tmp/work/a.md is not linked")]],
    ["/home/nova/out.csv", [path("/home/nova/out.csv")]],
    [
      "compare /work/a.md with /home/nova/b.md today",
      [
        text("compare "),
        path("/work/a.md"),
        text(" with "),
        path("/home/nova/b.md"),
        text(" today"),
      ],
    ],
    ["/work/ alone", [text("/work/ alone")]],
    ["/work/dir/ is a directory", [text("/work/dir/ is a directory")]],
    ["/work/../profile/Cookies", [text("/work/../profile/Cookies")]],
    ['"/work/final report.md"', [text('"/work/final report.md"')]],
    ["`/work/final report.md`", [text("`/work/final report.md`")]],
    ["'/home/nova/final report.md'", [text("'/home/nova/final report.md'")]],
    ["/profile/Cookies", [text("/profile/Cookies")]],
    ["", []],
  ])("%j", (body, expected) => {
    expect(splitWorkspacePaths(body)).toEqual(expected);
  });

  it("round-trips the body text", () => {
    const body = "a /work/x.md，b /home/n/y.txt. c\n/work/z";
    expect(
      splitWorkspacePaths(body)
        .map((s) => (s.kind === "text" ? s.text : s.path))
        .join(""),
    ).toBe(body);
  });
});

describe("downloadWorkspaceFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a same-origin attachment download without buffering a Blob", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as typeof globalThis.fetch;
    const api = createApiClient({ fetch });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const before = window.location.href;

    await downloadWorkspaceFile(api, WS_ID, "/work/out/report.csv");

    expect(calls).toHaveLength(0);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("report.csv");
    expect(clicked[0]?.getAttribute("href")).toBe(
      `/api/workspaces/ws_1/files?path=${encodeURIComponent("/work/out/report.csv")}`,
    );
    // Temporary: the anchor is gone from the document once the save was triggered.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(window.location.href).toBe(before);
  });

  it("includes a configured API base URL in the native download", async () => {
    const api = createApiClient({ baseUrl: "https://gateway.test" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadWorkspaceFile(api, WS_ID, "/work/big.bin");
    expect(click).toHaveBeenCalledTimes(1);
  });
});
