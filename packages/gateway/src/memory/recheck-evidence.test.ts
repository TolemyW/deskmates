import { describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { evidenceHash, hasRenewalEvidence, quotesSource } from "./recheck-evidence.js";

const text = "The current Cedar quota is 12.";
const note = { effectiveAt: "2026-10-17T00:00:00Z", lastConfirmedAt: "2026-10-19T00:00:00Z" };
const citation = { sourceId: "message:shared", quote: text };
function run(at = "2026-10-20T00:00:00Z", version = 2): Pick<RunRecord, "config"> {
  return {
    config: {
      memoryRecheckVersion: version,
      memoryRecheckSnapshot: {
        asOf: "2026-10-21T00:00:00Z",
        activity: text,
        evidence: [{ id: citation.sourceId, at, text, sha256: evidenceHash(text) }],
      },
    },
  };
}

describe("ADR-0053 citation validation", () => {
  it("requires evidence newer than observation AND confirmation, within the frozen window", () => {
    expect(hasRenewalEvidence(run(), note, citation)).toBe(true);
    for (const at of [
      "2026-10-18T00:00:00Z",
      note.lastConfirmedAt,
      "2026-10-22T00:00:00Z",
      "invalid",
    ])
      expect(hasRenewalEvidence(run(at), note, citation)).toBe(false);
    expect(
      hasRenewalEvidence(run(), { ...note, effectiveAt: "2026-10-20T12:00:00Z" }, citation),
    ).toBe(false);
  });

  it("rejects missing, invented, foreign and redacted quotes and legacy jobs", () => {
    expect(hasRenewalEvidence(run(), note, undefined)).toBe(false);
    expect(hasRenewalEvidence(run(), note, { ...citation, quote: "quota is 13" })).toBe(false);
    expect(hasRenewalEvidence(run(), note, { ...citation, sourceId: "message:private" })).toBe(
      false,
    );
    expect(hasRenewalEvidence(run(), note, { ...citation, quote: " " })).toBe(false);
    expect(hasRenewalEvidence(run(), note, { ...citation, quote: "[redacted]" })).toBe(false);
    expect(hasRenewalEvidence(run(undefined, 1), note, citation)).toBe(false);
  });

  it("accepts a quote copied from the escaped prompt or with folded whitespace, not a different fact", () => {
    const escaped = "Quota <Cedar> is 12 & rising;\n  see &lt;ops&gt; for details.";
    const r: Pick<RunRecord, "config"> = {
      config: {
        memoryRecheckVersion: 2,
        memoryRecheckSnapshot: {
          asOf: "2026-10-21T00:00:00Z",
          activity: escaped,
          evidence: [
            {
              id: citation.sourceId,
              at: "2026-10-20T00:00:00Z",
              text: escaped,
              sha256: evidenceHash(escaped),
            },
          ],
        },
      },
    };
    const quoted = (quote: string) => hasRenewalEvidence(r, note, { ...citation, quote });
    // Verbatim, as the sidecar's prompt shows it, and with line breaks folded.
    expect(quoted("Quota <Cedar> is 12 & rising;\n  see &lt;ops&gt; for details.")).toBe(true);
    expect(
      quoted("Quota &lt;Cedar&gt; is 12 &amp; rising; see &amp;lt;ops&amp;gt; for details."),
    ).toBe(true);
    expect(quoted("  is 12 &amp;   rising;  ")).toBe(true);
    // The quote is never decoded: a half-decoded mix matches neither form of the source.
    expect(quotesSource("12 & rising; see &amp;lt;ops", escaped)).toBe(false);
    expect(quotesSource(" \n ", escaped)).toBe(false);
    // Folding never turns a different statement into a match.
    expect(quoted("Quota <Cedar> is 13 & rising;")).toBe(false);
    expect(quoted("Quota <Cedar> is 12 & falling;")).toBe(false);
    expect(quoted("[redacted] rising;")).toBe(false);
  });

  it("rejects a changed snapshot whose content no longer matches its recorded hash", () => {
    const r = run();
    const snapshot = r.config.memoryRecheckSnapshot as { evidence: { text: string }[] };
    const source = snapshot.evidence[0];
    if (!source) throw new Error("fixture source missing");
    source.text = "The current Cedar quota is 13.";
    expect(hasRenewalEvidence(r, note, { ...citation, quote: source.text })).toBe(false);
  });
});
