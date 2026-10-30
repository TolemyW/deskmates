// T0 (ADR-0049 decisions 3 and 7): the one upstream request and the checked results.

import { describe, expect, it } from "vitest";
import { readSearchConfig } from "../config/search.js";
import { emptySearchEngineFailure, parseSearxngAnswer, searxngRequest } from "./searxng.js";

const service = (env: Record<string, string> = {}) => {
  const config = readSearchConfig({ SEARCH_URL: "http://127.0.0.1:18710", ...env }).search;
  if (!config) throw new Error("unreachable");
  return config;
};

describe("searxngRequest (decision 3)", () => {
  it("carries the query, JSON format, first page, safe search and nothing else", () => {
    const { url, init } = searxngRequest(service(), { query: "a&b=c #x" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("http://127.0.0.1:18710/search");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      q: "a&b=c #x",
      format: "json",
      pageno: "1",
      safesearch: "1",
    });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ accept: "application/json" });
  });

  it("adds the language and the configured Bearer", () => {
    const { url, init } = searxngRequest(service({ SEARCH_AUTH_TOKEN: "tok-1" }), {
      query: "仓库",
      language: "zh-CN",
    });
    expect(new URL(url).searchParams.get("language")).toBe("zh-CN");
    expect(init.headers).toEqual({ accept: "application/json", authorization: "Bearer tok-1" });
  });
});

describe("parseSearxngAnswer (decision 7)", () => {
  it("is undefined without a results array", () => {
    expect(parseSearxngAnswer("<html>", 5, ["*"])).toBeUndefined();
    expect(parseSearxngAnswer({ error: "x" }, 5, ["*"])).toBeUndefined();
    expect(parseSearxngAnswer(null, 5, ["*"])).toBeUndefined();
  });

  it("takes title, URL, snippet and engine, filters, de-duplicates and stops at the maximum", () => {
    const parsed = parseSearxngAnswer(
      {
        results: [
          { url: "https://a.example.com/", title: "A", content: "first", engine: "bing" },
          { url: "https://a.example.com/", title: "A again", content: "dup" },
          { url: "http://192.168.0.1/", title: "router", content: "x" },
          { url: "https://b.example.com/", title: "", content: "no title" },
          { url: "https://c.example.com/", title: "C", engines: ["brave", "qwant"] },
          { title: "no url" },
          "not an object",
          { url: "https://d.example.com/", title: "D" },
          { url: "https://e.example.com/", title: "E" },
        ],
      },
      3,
      ["*"],
    );
    expect(parsed?.results).toEqual([
      { title: "A", url: "https://a.example.com/", snippet: "first", engine: "bing" },
      { title: "C", url: "https://c.example.com/", snippet: "", engine: "brave" },
      { title: "D", url: "https://d.example.com/", snippet: "", engine: "" },
    ]);
    expect(parsed?.dropped).toBe(5);
  });

  it("cuts long titles and snippets", () => {
    const parsed = parseSearxngAnswer(
      {
        results: [
          { url: "https://a.example.com/", title: "t".repeat(400), content: "s".repeat(900) },
        ],
      },
      5,
      ["*"],
    );
    expect(parsed?.results[0]?.title.length).toBe(300);
    expect(parsed?.results[0]?.snippet.length).toBe(600);
  });
});

it("distinguishes empty results during engine failures from a healthy no-match answer", () => {
  expect(
    emptySearchEngineFailure({ results: [], unresponsive_engines: [["engine", "CAPTCHA"]] }),
  ).toBe(true);
  expect(emptySearchEngineFailure({ results: [], unresponsive_engines: [] })).toBe(false);
  expect(
    emptySearchEngineFailure({
      results: [{ url: "https://typesafe.ai" }],
      unresponsive_engines: [["another", "timeout"]],
    }),
  ).toBe(false);
  expect(emptySearchEngineFailure(null)).toBe(false);
});
