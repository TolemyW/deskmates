// T0. The tree that `main` pushes to the public mirror carries no blocked private identifier.
// The blocklist stores hashes, so this file names nothing either.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatFindings, hashToken, scanRepo, scanText, tokensOf } from "./public-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("public-scan", () => {
  it("tokenizes words, IPv4 literals with their /24 prefix, and e-mail addresses", () => {
    const tokens = tokensOf("See Host-Name at 10.1.2.3:8080 or mail Someone@Example.org.");
    expect(tokens).toContain("host");
    expect(tokens).toContain("name");
    expect(tokens).toContain("10.1.2.3");
    expect(tokens).toContain("10.1.2");
    expect(tokens).toContain("someone@example.org");
  });

  it("matches a blocked token by hash, case-insensitively", () => {
    const blocked = new Set([hashToken("Secret-Host".split("-")[0])]);
    expect(scanText("nothing here", blocked)).toEqual([]);
    expect(scanText("first line\nvisit SECRET.example", blocked)).toEqual([
      { line: 2, token: "secret" },
    ]);
  });

  // Reads every tracked file; under a full parallel run that can exceed the 5 s default.
  it("finds no blocked identifier in any tracked file", { timeout: 60_000 }, () => {
    const findings = scanRepo(root);
    expect(
      findings,
      `blocked identifiers in tracked files (see docs/runbooks/public-mirror.md):\n${formatFindings(findings)}`,
    ).toEqual([]);
  });
});
