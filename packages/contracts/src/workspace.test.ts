import { describe, expect, it } from "vitest";
import { egressAllowlistProblem, egressAllows, isEgressPattern } from "./workspace.js";

describe("egressAllows (deny by default)", () => {
  it("denies everything on an empty allowlist", () => {
    expect(egressAllows("example.com", [])).toBe(false);
  });

  it("matches exact hosts case-insensitively", () => {
    expect(egressAllows("Golden.Local", ["golden.local"])).toBe(true);
    expect(egressAllows("api.golden.local", ["golden.local"])).toBe(false);
  });

  it("matches wildcard suffixes including the apex", () => {
    expect(egressAllows("golden.local", ["*.golden.local"])).toBe(true);
    expect(egressAllows("a.b.golden.local", ["*.golden.local"])).toBe(true);
    expect(egressAllows("notgolden.local", ["*.golden.local"])).toBe(false);
  });

  it("reads '*' as any hostname that is not an IP literal (ADR-0010)", () => {
    for (const host of ["example.com", "WWW.Baidu.com", "a.b.c.github.io", "intranet"]) {
      expect(egressAllows(host, ["*"]), host).toBe(true);
    }
    // Names that are loopback or the host by definition are not "public" either: Chromium sends
    // localhost around the proxy, and the reserved host name reaches the host on any port.
    for (const host of [
      "localhost",
      "app.localhost",
      "host.docker.internal",
      "10.0.0.1",
      "127.0.0.1",
      "1.1.1.1",
      "127.1",
      "2130706433",
      "0x7f000001",
      "::1",
      "[::1]",
      "[fe80::1]",
      "::ffff:127.0.0.1",
      "",
      "has space.test",
      "evil.test/path",
    ]) {
      expect(egressAllows(host, ["*"]), host).toBe(false);
    }
  });
});

describe("isEgressPattern", () => {
  it("accepts a hostname, a wildcard suffix and the open-internet entry", () => {
    for (const ok of ["golden.local", "*.golden.local", "a-b.c.example.com", "localhost", "*"]) {
      expect(isEgressPattern(ok), ok).toBe(true);
    }
  });

  it("rejects anything that is not one", () => {
    for (const bad of [
      "",
      "**",
      "*.*",
      "*.",
      "https://golden.local",
      "golden.local/path",
      "golden.local:443",
      "golden .local",
      "golden..local",
      "-golden.local",
    ]) {
      expect(isEgressPattern(bad), bad).toBe(false);
    }
  });
});

describe("egressAllowlistProblem", () => {
  it("accepts ordinary lists, the empty list and a lone '*'", () => {
    expect(egressAllowlistProblem([])).toBeUndefined();
    expect(egressAllowlistProblem(["a.example.test", "*.b.example.test"])).toBeUndefined();
    expect(egressAllowlistProblem(["*"])).toBeUndefined();
    expect(egressAllowlistProblem(["*", "*"])).toBeUndefined();
  });

  it("names the first invalid pattern", () => {
    expect(egressAllowlistProblem(["ok.test", "https://evil.test/"])).toContain(
      '"https://evil.test/"',
    );
  });

  it("refuses '*' mixed with any other entry", () => {
    expect(egressAllowlistProblem(["*", "example.com"])).toMatch(/only entry/);
    expect(egressAllowlistProblem(["*.example.com", "*"])).toMatch(/only entry/);
  });
});
