import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_DIR,
  BROWSER_EVIDENCE_FILE,
  isBrowserEvidencePath,
} from "./browser-evidence.js";

describe("browser evidence references (issue #65)", () => {
  const name = "12345678-1234-1234-1234-123456789abc.txt";
  it("accepts only a cache file directly under the evidence directory", () => {
    expect(BROWSER_EVIDENCE_FILE.test(name)).toBe(true);
    expect(isBrowserEvidencePath(`${BROWSER_EVIDENCE_DIR}/${name}`)).toBe(true);
  });
  it.each([
    "https://outside.test/secret",
    "/profile/Cookies",
    "/work/browser-evidence/../secret.txt",
    `/work/browser-evidence/sub/${name}`,
    `/work/browser-evidence/${name}\n`,
    42,
    undefined,
  ])("rejects %s", (path) => {
    expect(isBrowserEvidencePath(path)).toBe(false);
  });
});
