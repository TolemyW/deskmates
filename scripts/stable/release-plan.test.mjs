import { describe, expect, it } from "vitest";
import { nextPatch, releaseNotes, releaseTags } from "./release-plan.mjs";

const record = (parents, subject, body = "") => `${parents}\x1f${subject}\x1f${body}\x1e`;

describe("release plan", () => {
  it("orders release tags by version, not text, and ignores anything else", () => {
    expect(releaseTags(["v0.5.9", "v0.5.10", "v0.4.20", "latest", "v1.0", " v0.5.8 "])).toEqual([
      "v0.5.10",
      "v0.5.9",
      "v0.5.8",
      "v0.4.20",
    ]);
  });

  it("takes the next patch after the highest tag", () => {
    expect(nextPatch(["v0.5.8", "v0.5.9", "v0.4.30"])).toBe("v0.5.10");
    expect(() => nextPatch(["latest"])).toThrow(/no vX.Y.Z tag/);
  });

  it("lists merged pull requests by title and other commits by subject, oldest first", () => {
    // git log prints newest first.
    const log =
      record(
        "a b",
        "Merge pull request #86 from owner/ui/chat",
        "Keep chat details inspectable\n",
      ) +
      record("c", "Fix a typo in the runbook") +
      record("d e", "Merge pull request #84 from owner/ui/files", "Compact chat file rows");
    expect(releaseNotes("v0.5.10", log)).toBe(
      "Release v0.5.10\n\n" +
        "- Compact chat file rows (#84)\n" +
        "- Fix a typo in the runbook\n" +
        "- Keep chat details inspectable (#86)\n",
    );
  });

  it("refuses to describe a release with nothing in it", () => {
    expect(() => releaseNotes("v0.5.10", "")).toThrow(/nothing landed/);
  });
});
