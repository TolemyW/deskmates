import { createHash } from "node:crypto";

/** Offline structural checks for the dated us-stocks fixture, not investment evaluation. */
export const EQUITY_ARTIFACT_PATHS = [
  "/work/fundamentals.md",
  "/work/strategy-draft.json",
  "/work/risk-review.md",
  "/work/investment-report.md",
  "/work/strategy.json",
] as const;

const TICKERS = ["AAPL", "MSFT", "NVDA"] as const;
const OFFICIAL_HOSTS = new Set(["www.apple.com", "www.microsoft.com", "investor.nvidia.com"]);
const WEIGHT_TOLERANCE = 1e-9;

export interface ArtifactAudit {
  scope: "equity-2026-10-01-structure-only";
  status: "structure-valid" | "invalid";
  issues: { path: string; field: string; problem: string }[];
  files: { path: string; sha256: string }[];
  /** These cannot be inferred from a marker or from file structure. */
  unchecked: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return object(value) && Object.keys(value).length > 0;
}

function officialUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      OFFICIAL_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

/**
 * Input is an explicit captured snapshot: { files: { absolutePath: UTF8Text },
 * expectedSourceUrls?: string[] }. No filesystem, Gateway, browser or model access.
 * The optional URL list binds the output to the operator's dated source pack.
 * A checklist remains valid risk input under the existing fixture contract.
 */
export function auditEquityArtifacts(snapshot: unknown): ArtifactAudit {
  const audit: ArtifactAudit = {
    scope: "equity-2026-10-01-structure-only",
    status: "invalid",
    issues: [],
    files: [],
    unchecked: [
      "Independent source retrieval, fiscal periods, units and financial claim accuracy",
      "Prose/JSON allocation agreement and substantive entry, exit and backtest rules",
      "Final-allocation risk review (the fixture permits a clearly labelled checklist)",
      "Artifact freshness, authorship, delegation and write-before-marker ordering",
      "Task/run success and absence of unintended external side effects",
    ],
  };
  const issue = (path: string, field: string, problem: string) => {
    audit.issues.push({ path, field, problem });
  };
  if (!object(snapshot) || !object(snapshot.files)) {
    issue("snapshot", "files", "Expected an explicit object mapping paths to file text");
    return audit;
  }
  const files = snapshot.files;
  const parsed = new Map<string, Record<string, unknown>>();
  for (const path of EQUITY_ARTIFACT_PATHS) {
    const content = Object.hasOwn(files, path) ? files[path] : undefined;
    if (typeof content !== "string" || content.trim().length === 0) {
      issue(path, "content", "Required exact path must contain nonempty text");
      continue;
    }
    audit.files.push({ path, sha256: createHash("sha256").update(content).digest("hex") });
    if (!path.endsWith(".json")) continue;
    try {
      const value: unknown = JSON.parse(content);
      if (object(value)) parsed.set(path, value);
      else issue(path, "json", "Expected a JSON object");
    } catch {
      issue(path, "json", "Malformed JSON");
    }
  }
  const path = "/work/strategy.json";
  const strategy = parsed.get(path);
  if (strategy) {
    if (strategy.asOf !== "2026-10-01") issue(path, "asOf", "Expected the fixed observation date");
    const universe = strategy.universe;
    if (
      !Array.isArray(universe) ||
      universe.length !== TICKERS.length ||
      !TICKERS.every((ticker) => universe.includes(ticker))
    ) {
      issue(path, "universe", "Expected each of AAPL, MSFT and NVDA exactly once");
    }
    const weights = strategy.weights;
    if (
      !object(weights) ||
      Object.keys(weights).length !== TICKERS.length ||
      !TICKERS.every((ticker) => Object.hasOwn(weights, ticker))
    ) {
      issue(path, "weights", "Expected exactly the three universe ticker keys");
    }
    let total = 0;
    let numeric = object(weights);
    for (const ticker of TICKERS) {
      const weight = object(weights) ? weights[ticker] : undefined;
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        numeric = false;
        issue(path, `weights.${ticker}`, "Expected a finite number");
      } else {
        total += weight;
        if (weight < 0 || weight > 0.35) issue(path, `weights.${ticker}`, "Outside [0, 0.35]");
      }
    }
    const cash = strategy.cashWeight;
    if (typeof cash !== "number" || !Number.isFinite(cash)) {
      numeric = false;
      issue(path, "cashWeight", "Expected a finite number");
    } else {
      total += cash;
      if (cash < 0.1 || cash > 1) issue(path, "cashWeight", "Outside [0.1, 1]");
    }
    if (numeric && Math.abs(total - 1) > WEIGHT_TOLERANCE) {
      issue(path, "weights+cashWeight", "Must sum to one within 1e-9");
    }
    if (strategy.maxLeverage !== 1) issue(path, "maxLeverage", "Expected numeric 1");
    if (strategy.backtestStatus !== "not-run") issue(path, "backtestStatus", "Expected not-run");
    for (const field of ["rebalance", "entryRule", "exitRule", "riskLimits"]) {
      if (!nonempty(strategy[field])) issue(path, field, "Required nonempty rule or specification");
    }
    const sourceValues = Array.isArray(strategy.sources)
      ? strategy.sources.map((source: unknown) => (object(source) ? source.url : source))
      : [];
    if (sourceValues.length === 0 || sourceValues.some((source) => !officialUrl(source))) {
      issue(path, "sources", "Expected HTTPS official source URLs from the fixture hosts");
    }
    if (snapshot.expectedSourceUrls !== undefined) {
      const expected = snapshot.expectedSourceUrls;
      if (!Array.isArray(expected) || expected.length === 0 || !expected.every(officialUrl)) {
        issue("snapshot", "expectedSourceUrls", "Expected nonempty official source URL list");
      } else if (!expected.every((source) => sourceValues.includes(source))) {
        issue(path, "sources", "A dated source-pack URL is missing or changed");
      }
    }
  }
  audit.status = audit.issues.length ? "invalid" : "structure-valid";
  return audit;
}
