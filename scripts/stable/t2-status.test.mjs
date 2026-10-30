import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { t2Status } from "./t2-status.mjs";

let root;
let release;
let receipt;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t2-status-"));
  release = join(root, "v0.7.7");
  mkdirSync(join(release, ".release"), { recursive: true });
  receipt = join(release, ".release/t2.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("target-host T2 status", () => {
  it("prints the receipt when invoked through a symlink, including a current release link", () => {
    const alias = join(root, "status.mjs");
    symlinkSync(fileURLToPath(new URL("./t2-status.mjs", import.meta.url)), alias);
    writeFileSync(receipt, JSON.stringify({ version: "v0.7.7", scope: "full", exitCode: 0 }));
    expect(execFileSync(process.execPath, [alias, release], { encoding: "utf8" })).toContain(
      "t2       v0.7.7: passed (scope=full, exitCode=0;",
    );
  });
  it("reports unknown without a receipt, even with a passed marker or packaging claim", () => {
    writeFileSync(join(release, ".release/t2.passed"), "");
    writeFileSync(join(release, "release-manifest.json"), '{"gates":{"t2":"passed"}}');
    expect(t2Status(release)).toContain("unknown (no receipt;");
  });

  it.each(["smoke", "full"])("reports the actual %s receipt and points to skip counts", (scope) => {
    writeFileSync(receipt, JSON.stringify({ version: "v0.7.7", scope, exitCode: 0 }));
    expect(t2Status(release)).toContain(`passed (scope=${scope}, exitCode=0;`);
    expect(t2Status(release)).toContain("counts and skips: .release/t2.log");
  });

  it("reports a failed full repeat despite an older passed marker", () => {
    writeFileSync(join(release, ".release/t2.passed"), "");
    writeFileSync(receipt, JSON.stringify({ version: "v0.7.7", scope: "full", exitCode: 1 }));
    expect(t2Status(release)).toContain("failed (scope=full, exitCode=1;");
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ version: "v0.7.6", scope: "full", exitCode: 0 }),
    JSON.stringify({ version: "v0.7.7", scope: "other", exitCode: 0 }),
    JSON.stringify({ version: "v0.7.7", scope: "full" }),
    JSON.stringify({ version: "v0.7.7", scope: "full", exitCode: "0" }),
    JSON.stringify({ version: "v0.7.7", scope: "full", exitCode: -1 }),
  ])("never promotes a malformed or mismatched receipt to a pass: %s", (body) => {
    writeFileSync(receipt, body);
    expect(t2Status(release)).toContain("unknown (");
  });
});
