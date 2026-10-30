// T0 (ADR-0049 decision 2): `SEARCH_URL` turns web search on for the installation, nothing else.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSearchConfig } from "./search.js";

describe("readSearchConfig", () => {
  it("is off when nothing is set", () => {
    expect(readSearchConfig({})).toEqual({});
    expect(readSearchConfig({ SEARCH_URL: "  " })).toEqual({});
  });

  it("appends /search to a base URL and keeps a full one", () => {
    const base = readSearchConfig({ SEARCH_URL: "http://127.0.0.1:18710/" }).search;
    expect(base?.url).toBe("http://127.0.0.1:18710/search");
    expect(base?.endpointSha256).toBe(
      createHash("sha256").update("http://127.0.0.1:18710/search").digest("hex"),
    );
    expect(base?.authToken).toBeUndefined();
    expect(readSearchConfig({ SEARCH_URL: "https://search.example/search" }).search?.url).toBe(
      "https://search.example/search",
    );
  });

  it("keeps the optional token", () => {
    expect(
      readSearchConfig({ SEARCH_URL: "http://127.0.0.1:18710", SEARCH_AUTH_TOKEN: "secret-1" })
        .search?.authToken,
    ).toBe("secret-1");
  });

  it("stops startup on a bad URL or a token without a URL, without echoing the token", () => {
    expect(() => readSearchConfig({ SEARCH_URL: "ftp://x" })).toThrow(/SEARCH_URL/);
    expect(() => readSearchConfig({ SEARCH_URL: "not a url" })).toThrow(/SEARCH_URL/);
    expect(() => readSearchConfig({ SEARCH_URL: "http://u:p@127.0.0.1" })).toThrow(/credentials/);
    let message = "";
    try {
      readSearchConfig({ SEARCH_AUTH_TOKEN: "very-secret-token" });
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/SEARCH_AUTH_TOKEN is set without SEARCH_URL/);
    expect(message).not.toContain("very-secret-token");
  });
});
