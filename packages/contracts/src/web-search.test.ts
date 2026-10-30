// T0 (ADR-0049 decisions 5 and 7): the request bounds and the result filter both sides apply.

import { describe, expect, it } from "vitest";
import {
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_QUERY_MAX_CHARS,
  webSearchRequestProblem,
  webSearchResultUrl,
  webSearchText,
} from "./web-search.js";

describe("webSearchRequestProblem (decision 5)", () => {
  it("accepts a plain query with and without the optional fields", () => {
    expect(webSearchRequestProblem({ query: "galaxy ops console" })).toBeUndefined();
    expect(
      webSearchRequestProblem({ query: "仓库 搬迁", maxResults: 10, language: "zh-CN" }),
    ).toBeUndefined();
    expect(webSearchRequestProblem({ query: "x", maxResults: 1, language: "en" })).toBeUndefined();
  });

  it("refuses an empty, long or control-character query", () => {
    expect(webSearchRequestProblem({ query: "   " })).toMatch(/empty/);
    expect(webSearchRequestProblem({ query: 3 })).toMatch(/text/);
    expect(webSearchRequestProblem({ query: "a".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) })).toMatch(
      /at most/,
    );
    expect(webSearchRequestProblem({ query: "a\u0000b" })).toMatch(/control/);
    expect(webSearchRequestProblem({ query: "a\nb" })).toMatch(/control/);
  });

  it("refuses a bad maxResults or language", () => {
    for (const maxResults of [0, WEB_SEARCH_MAX_RESULTS + 1, 2.5, "3"])
      expect(webSearchRequestProblem({ query: "q", maxResults })).toMatch(/maxResults/);
    for (const language of ["EN", "english", "zh_CN", "", 7])
      expect(webSearchRequestProblem({ query: "q", language })).toMatch(/language/);
  });
});

describe("webSearchResultUrl (decision 7)", () => {
  const open = ["*"];

  it("keeps public http(s) URLs", () => {
    expect(webSearchResultUrl("https://example.com/a?b=1", open)).toBe("https://example.com/a?b=1");
    expect(webSearchResultUrl("http://docs.example.org", open)).toBe("http://docs.example.org/");
  });

  it("drops IP literals in every spelling, even when the allowlist names them", () => {
    for (const url of [
      "http://10.0.0.5/admin",
      "http://192.168.1.1/",
      "http://8.8.8.8/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://[::1]/",
      "http://[2001:db8::1]/",
    ])
      expect(webSearchResultUrl(url, ["*", "10.0.0.5", "8.8.8.8"]), url).toBeUndefined();
  });

  it("drops loopback, reserved, single-label and private-suffix names", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://host.docker.internal:8080/",
      "http://intranet/",
      "http://printer.local/",
      "http://wiki.corp/",
      "http://nas.lan/",
      "http://router.home.arpa/",
      "http://db.internal/",
    ])
      expect(webSearchResultUrl(url, open), url).toBeUndefined();
  });

  it("drops other schemes, credentials, long and malformed URLs", () => {
    for (const url of [
      "ftp://example.com/file",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@example.com/",
      "https://token@example.com/",
      `https://example.com/${"a".repeat(2100)}`,
      "not a url",
      "",
    ])
      expect(webSearchResultUrl(url, open), url).toBeUndefined();
    expect(webSearchResultUrl(42, open)).toBeUndefined();
  });

  it("keeps a reserved or internal name an explicit allowlist entry names, never through *", () => {
    expect(webSearchResultUrl("http://host.docker.internal:8080/p", ["host.docker.internal"])).toBe(
      "http://host.docker.internal:8080/p",
    );
    expect(webSearchResultUrl("http://wiki.corp/page", ["*.corp"])).toBe("http://wiki.corp/page");
    expect(webSearchResultUrl("http://wiki.corp/page", ["*"])).toBeUndefined();
  });

  it("applies the same public-name rule in a locked workspace", () => {
    // A locked workspace still sees public results: opening one is the egress ask (decision 9).
    expect(webSearchResultUrl("https://unlisted.example.com/", ["docs.example.org"])).toBe(
      "https://unlisted.example.com/",
    );
  });
});

describe("webSearchText (decision 7)", () => {
  it("removes control characters, folds whitespace and cuts", () => {
    expect(webSearchText("a\u0000b\n\n  c", 50)).toBe("a b c");
    expect(webSearchText("abcdef", 4)).toBe("abc…");
    expect(webSearchText(undefined, 4)).toBe("");
  });
});
