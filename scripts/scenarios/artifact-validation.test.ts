import { describe, expect, it } from "vitest";
import { EQUITY_ARTIFACT_PATHS, auditEquityArtifacts } from "./artifact-validation.js";

const sources = [
  "https://www.apple.com/newsroom/fixture",
  "https://www.microsoft.com/investor/fixture",
  "https://investor.nvidia.com/fixture",
];

function strategy(): Record<string, unknown> {
  return {
    asOf: "2026-10-01",
    universe: ["AAPL", "MSFT", "NVDA"],
    weights: { AAPL: 0.28, MSFT: 0.3, NVDA: 0.2 },
    cashWeight: 0.22,
    maxLeverage: 1,
    rebalance: "monthly",
    entryRule: "Evaluate the fixed research signals at the next monthly review",
    exitRule: "Review if portfolio drawdown exceeds 10%",
    riskLimits: { drawdownReview: 0.1 },
    backtestStatus: "not-run",
    sources,
  };
}

function snapshot(value = strategy()) {
  return {
    files: {
      "/work/fundamentals.md": "Dated fundamentals fixture; claims require human verification.",
      "/work/strategy-draft.json": JSON.stringify({ proposal: "Draft schema is not prescribed" }),
      "/work/risk-review.md": "Risk checklist only; final allocation was not available.",
      "/work/investment-report.md": "Dated report fixture; prose correctness is not asserted here.",
      "/work/strategy.json": JSON.stringify(value),
    } as Record<string, string>,
    expectedSourceUrls: [...sources],
  };
}

describe("offline dated equity artifact structure", () => {
  it("validates supplied constraints without claiming complete scenario or research success", () => {
    const result = auditEquityArtifacts(snapshot());
    expect(result.status).toBe("structure-valid");
    expect(result.issues).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(EQUITY_ARTIFACT_PATHS);
    expect(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(result.unchecked).toContain(
      "Final-allocation risk review (the fixture permits a clearly labelled checklist)",
    );
    expect(result.unchecked).toContain(
      "Artifact freshness, authorship, delegation and write-before-marker ordering",
    );
  });

  it("does not accept the reported fundamentals filename substitution", () => {
    const input = snapshot();
    input.files["/work/fundamentals-report.md"] = "An otherwise valid report";
    Reflect.deleteProperty(input.files, "/work/fundamentals.md");
    expect(auditEquityArtifacts(input).issues).toContainEqual({
      path: "/work/fundamentals.md",
      field: "content",
      problem: "Required exact path must contain nonempty text",
    });
  });

  it.each(EQUITY_ARTIFACT_PATHS)("rejects missing or empty %s", (path) => {
    const input = snapshot();
    delete input.files[path];
    expect(auditEquityArtifacts(input).status).toBe("invalid");
    input.files[path] = " \n";
    expect(auditEquityArtifacts(input).status).toBe("invalid");
  });

  it.each(["/work/strategy.json", "/work/strategy-draft.json"])(
    "requires parseable object JSON for %s",
    (path) => {
      for (const body of ["{bad", "[]", "null", '"text"']) {
        const input = snapshot();
        input.files[path] = body;
        expect(auditEquityArtifacts(input).issues.some((issue) => issue.field === "json")).toBe(
          true,
        );
      }
    },
  );

  it.each([
    ["asOf", "2026-10-03"],
    ["universe", ["AAPL", "AAPL", "NVDA"]],
    ["universe", ["AAPL", "MSFT", "NVDA", "TSLA"]],
    ["weights", { AAPL: "0.28", MSFT: 0.3, NVDA: 0.2 }],
    ["weights", { AAPL: 0.28, MSFT: 0.3 }],
    ["weights", { AAPL: 0.28, MSFT: 0.3, NVDA: 0.2, TSLA: 0 }],
    ["weights", { AAPL: -0.01, MSFT: 0.3, NVDA: 0.2 }],
    ["weights", { AAPL: 0.36, MSFT: 0.3, NVDA: 0.2 }],
    ["cashWeight", 0.09],
    ["cashWeight", "0.22"],
    ["cashWeight", 0.23],
    ["maxLeverage", 2],
    ["maxLeverage", "1"],
    ["backtestStatus", "passed"],
    ["rebalance", ""],
    ["entryRule", {}],
    ["exitRule", null],
    ["riskLimits", []],
    ["sources", []],
  ])("rejects invalid %s", (field, value) => {
    expect(auditEquityArtifacts(snapshot({ ...strategy(), [field as string]: value })).status).toBe(
      "invalid",
    );
  });

  it("accepts cap boundary and ordinary floating point rounding", () => {
    const value = strategy();
    value.weights = { AAPL: 0.35, MSFT: 0.35, NVDA: 0.2 };
    value.cashWeight = 0.1;
    expect(auditEquityArtifacts(snapshot(value)).status).toBe("structure-valid");
  });

  it("rejects JSON numeric overflow instead of treating infinity as a weight", () => {
    const input = snapshot();
    input.files["/work/strategy.json"] = JSON.stringify(strategy()).replace(
      '"AAPL":0.28',
      '"AAPL":1e400',
    );
    expect(auditEquityArtifacts(input).issues).toContainEqual({
      path: "/work/strategy.json",
      field: "weights.AAPL",
      problem: "Expected a finite number",
    });
  });

  it.each([
    "http://www.apple.com/newsroom/fixture",
    "https://www.apple.com.evil.test/fixture",
    "https://www.apple.com@evil.test/fixture",
    "https://secret@www.apple.com/newsroom/fixture",
    "https://127.0.0.1/fixture",
    "javascript:alert(1)",
    "https://www.apple.com:8443/fixture",
  ])("rejects an unsafe or non-fixture source URL: %s", (source) => {
    expect(auditEquityArtifacts(snapshot({ ...strategy(), sources: [source] })).status).toBe(
      "invalid",
    );
  });

  it("binds exact source-pack links without pretending to retrieve or fact-check them", () => {
    const value = {
      ...strategy(),
      sources: sources.map((url) => ({ url, title: "Official source" })),
    };
    expect(auditEquityArtifacts(snapshot(value)).status).toBe("structure-valid");
    value.sources[0] = { url: "https://www.apple.com/newer-period", title: "Official source" };
    expect(auditEquityArtifacts(snapshot(value)).issues).toContainEqual({
      path: "/work/strategy.json",
      field: "sources",
      problem: "A dated source-pack URL is missing or changed",
    });
  });

  it("rejects invalid snapshot and source-pack shapes without printing supplied contents", () => {
    for (const input of [null, [], { files: [] }, { files: "private content" }]) {
      const result = auditEquityArtifacts(input);
      expect(result.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain("private content");
    }
    expect(auditEquityArtifacts({ ...snapshot(), expectedSourceUrls: [] }).status).toBe("invalid");
  });

  it("neither trusts inherited filenames nor mutates the input snapshot", () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    auditEquityArtifacts(input);
    expect(JSON.stringify(input)).toBe(before);
    const inherited = { files: Object.create(input.files) };
    expect(auditEquityArtifacts(inherited).files).toEqual([]);
    expect(auditEquityArtifacts(inherited).issues).toHaveLength(5);
  });

  it("a completion marker alone proves no artifacts", () => {
    expect(auditEquityArtifacts({ files: {}, reply: "STOCK_REPORT_READY" }).status).toBe("invalid");
  });
});
