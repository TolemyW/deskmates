import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenSiteState } from "@deskmates/golden-site";
import { afterEach, describe, expect, it } from "vitest";
import { type MissionReport, reserveReport, saveReport } from "./report.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "deskmates-mission-report-"));
  dirs.push(dir);
  return dir;
}

describe("long-horizon report reservation", () => {
  it("reserves before effects and refuses to overwrite an earlier attempt", () => {
    const dir = directory();
    const pin = { mission: "test", imageId: "sha256:test" };
    const file = reserveReport(dir, "mission__base__r1", pin);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      state: "reserved",
      outcome: "unknown",
    });
    expect(() => reserveReport(dir, "mission__base__r1", pin)).toThrow();
    expect(() =>
      reserveReport(dir, "mission__base__r2", { ...pin, imageId: "sha256:changed" }),
    ).toThrow("pins a different");
  });
  it("rejects secret-shaped reports without replacing the reserved unknown receipt", () => {
    const file = reserveReport(directory(), "case", { mission: "test" });
    // A deliberately partial fixture exercises the generic export guard before report fields.
    const bad = { token: "should-not-export" } as unknown as MissionReport;
    expect(() => saveReport(file, bad, [])).toThrow("secret-shaped");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("state", "reserved");
  });
  it("exports controlled fixture state with a token digest without mutating oracle evidence", () => {
    const state = new GoldenSiteState().view();
    const original = state.settings.apiToken;
    const file = reserveReport(directory(), "case", { mission: "test" });
    // Partial fixture: this test concerns export, not the runner's complete report schema.
    saveReport(file, { site: { seed: state } } as unknown as MissionReport, []);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.site.seed.settings.apiToken).toBe("[redacted]");
    expect(saved.settingsApiTokenDigests.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(state.settings.apiToken).toBe(original);
  });
});
