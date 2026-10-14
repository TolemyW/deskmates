import { describe, expect, it, vi } from "vitest";
import { ledgerToolResult, toolResultExcerpt } from "./tool-evidence.js";
import { wrapPageContent } from "./untrusted.js";

describe("browser ledger evidence", () => {
  const text = wrapPageContent(
    "https://answer.test",
    `### Open tabs\n${"- 0: [old](https://login.test/?token=secret123&next=old)\n".repeat(300)}### Page\n- Page URL: https://answer.test/source\n### Snapshot\nFINAL_PAGE_CANARY\n### Events\n${"console noise\n".repeat(1000)}`,
  );
  it("keeps the page, source and explicit omission separately from long inventories/logs", async () => {
    const save = vi.fn(async (_text: string) => ({
      path: "/work/browser-evidence/test.txt",
      sha256: "hash",
      bytes: 10,
      truncated: false,
      expiresAt: "later",
    }));
    const result = await ledgerToolResult(text, true, [], save);
    expect(result.content).toContain("FINAL_PAGE_CANARY");
    expect(result.content).toContain("https://answer.test/source");
    expect(result.content).toContain("Incomplete ledger excerpt");
    expect(String(result.content).length).toBeLessThanOrEqual(4000);
    expect(result).toMatchObject({
      truncated: true,
      evidence: { path: "/work/browser-evidence/test.txt" },
    });
    expect(save.mock.calls[0]?.[0]).toContain("- 0:");
    expect(save.mock.calls[0]?.[0]).not.toContain("secret123");
    expect(save.mock.calls[0]?.[0]).toContain("FINAL_PAGE_CANARY");
    // The original model-facing value is untouched.
    expect(text).toContain("secret123");
  });
  it("redacts credentials before cutting through their value", async () => {
    const result = await ledgerToolResult(
      `${"a".repeat(3980)} Bearer ${"SECRET".repeat(500)}`,
      false,
      [],
    );
    expect(result.content).not.toContain("SECRET");
  });
  it.each(["?token=secret123", "?a=1&amp;token=secret123"])(
    "redacts escaped query credentials %s",
    async (query) => {
      const result = await ledgerToolResult(query, true, []);
      expect(result.content).not.toContain("secret123");
    },
  );
  it("keeps malformed/oversized text bounded and marks unavailable artifacts", async () => {
    const result = await ledgerToolResult("x".repeat(1000000), true, [], async () => {
      throw Error("private path");
    });
    expect(String(result.content).length).toBeLessThanOrEqual(4000);
    expect(result).toMatchObject({
      truncated: true,
      evidence: { unavailable: expect.stringContaining("incomplete") },
    });
    expect(JSON.stringify(result)).not.toContain("private path");
  });
  it("preserves small results, errors and screenshot references", () => {
    for (const text of ["", "### Error\nblocked", "### Result\n[shot](/work/screenshot.png)"])
      expect(toolResultExcerpt(text, true)).toBe(text);
  });
});
