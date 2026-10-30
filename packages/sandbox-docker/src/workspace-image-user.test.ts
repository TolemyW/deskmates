// T0, issue #3 B: the workspace image runs every process as root. Bot tools run as root with no
// Linux capabilities (the provider drops them all), so a file in /work owned by another uid is
// read-only to every bot (no CAP_DAC_OVERRIDE) and cannot be chowned back (no CAP_CHOWN). A
// `USER` directive in either Dockerfile would make the desktop, the sidecar and every platform
// exec write as that user instead; the provider side (no `User` on create or exec) is checked in
// docker-provider.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

describe("workspace images run as root", () => {
  for (const file of ["images/workspace-base/Dockerfile", "images/workspace/Dockerfile"]) {
    it(`${file} sets no USER`, () => {
      const text = readFileSync(new URL(file, root), "utf8");
      expect(text.split("\n").filter((line) => /^\s*USER\s/i.test(line))).toEqual([]);
    });
  }
});
