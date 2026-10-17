// T0. The tree that `main` pushes to the public mirror carries no blocked private identifier.
// The blocklist stores hashes, so this file names nothing either.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatFindings, hashToken, scanRepo, scanText, tokensOf } from "./public-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// The scan reads `git ls-files`, so it only applies to a checkout. A shipped release is a
// `git archive` of a tag that already passed this test on `main`; there the tree has no `.git`
// and `stable.sh verify` runs T0/T1 on it, so the tracked-file case is skipped, not failed.
function isGitWorkTree(dir) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

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
  it.skipIf(!isGitWorkTree(root))(
    "finds no blocked identifier in any tracked file",
    { timeout: 60_000 },
    () => {
      const findings = scanRepo(root);
      expect(
        findings,
        `blocked identifiers in tracked files (see docs/runbooks/public-mirror.md):\n${formatFindings(findings)}`,
      ).toEqual([]);
    },
  );
});
