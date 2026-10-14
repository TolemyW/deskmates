// Host-only campaign accounting. No environment lookup, model SDK, or default authorization.
import { createHash } from "node:crypto";

export function memoryDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requireMemoryHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid ${label} hash`);
}

export function requireMemoryInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive bounded safe integer`);
  }
}

export interface MemoryAttemptLimits {
  maxTokens: number;
  maxCostMicrousd: number;
  maxTurns: number;
  maxDurationMs: number;
}

/** A host-recorded, explicit approval reference, not proof that approval was obtained.
 * The future launcher must verify the reference; an old invocation ceiling is not a budget. */
export interface MemoryCampaignAuthorization {
  approvalReference: string;
  approvedBy: string;
  campaignId: string;
  driverPlanSha256: string;
  approvedAtMs: number;
  expiresAtMs: number;
  maxAttempts: number;
  maxTokens: number;
  maxCostMicrousd: number;
}

/** Gateway/proxy accounting, including all retries/subrequests in this attempt.
 * Never substitute SDK costUSD. Unknown counters and unknown prices stay null. */
export interface MemoryAttemptUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  costMicrousd: number | null;
}

interface ChargedAttempt {
  key: string;
  usage: MemoryAttemptUsage | null;
  state: "intent" | "settled" | "unknown";
  chargedTokens: bigint;
  chargedCostMicrousd: bigint;
}

export class MemoryBudget {
  private readonly authorization: MemoryCampaignAuthorization;
  private readonly limits: MemoryAttemptLimits;
  private readonly attempts: ChargedAttempt[] = [];
  private blocked: string | null = null;

  constructor(
    authorization: MemoryCampaignAuthorization | null,
    campaignId: string,
    driverPlanSha256: string,
    limits: MemoryAttemptLimits,
    nowMs: number,
  ) {
    if (!authorization) throw new Error("explicit campaign authorization and cost budget required");
    this.authorization = structuredClone(authorization);
    this.limits = structuredClone(limits);
    requireMemoryHash(driverPlanSha256, "driver plan");
    if (
      authorization.campaignId !== campaignId ||
      authorization.driverPlanSha256 !== driverPlanSha256 ||
      !authorization.approvalReference.trim() ||
      !authorization.approvedBy.trim()
    ) {
      throw new Error("authorization scope/plan/reference mismatch");
    }
    requireMemoryInteger(authorization.maxAttempts, "attempt budget", 1_000_000);
    requireMemoryInteger(authorization.maxTokens, "token budget");
    requireMemoryInteger(authorization.maxCostMicrousd, "cost budget");
    requireMemoryInteger(limits.maxTokens, "attempt token cap");
    requireMemoryInteger(limits.maxCostMicrousd, "attempt cost cap");
    requireMemoryInteger(limits.maxTurns, "turn cap", 10_000);
    requireMemoryInteger(limits.maxDurationMs, "duration cap", 86_400_000);
    requireMemoryInteger(authorization.approvedAtMs, "approval time");
    requireMemoryInteger(authorization.expiresAtMs, "expiry time");
    if (
      limits.maxTokens > authorization.maxTokens ||
      limits.maxCostMicrousd > authorization.maxCostMicrousd ||
      authorization.approvedAtMs >= authorization.expiresAtMs
    ) {
      throw new Error("attempt caps exceed approval or invalid approval interval");
    }
    this.assertAvailable(nowMs);
  }

  assertAvailable(nowMs: number): void {
    requireMemoryInteger(nowMs, "clock time");
    if (this.blocked) throw new Error(this.blocked);
    if (nowMs < this.authorization.approvedAtMs || nowMs >= this.authorization.expiresAtMs) {
      throw new Error("campaign approval is not currently valid");
    }
  }

  /** Called BEFORE durable intent and invocation. Never roll back a failed/uncertain intent. */
  reserve(key: string, nowMs: number): MemoryAttemptLimits {
    this.assertAvailable(nowMs);
    if (!key || this.attempts.some((attempt) => attempt.key === key)) {
      throw new Error("empty or duplicate attempt reservation; automatic retries forbidden");
    }
    if (this.attempts.some((attempt) => attempt.state !== "settled")) {
      throw new Error("unresolved attempt; reconcile manually before any further invocation");
    }
    const current = this.totals();
    if (
      this.attempts.length >= this.authorization.maxAttempts ||
      BigInt(this.limits.maxTokens) >
        BigInt(this.authorization.maxTokens) - current.chargedTokens ||
      BigInt(this.limits.maxCostMicrousd) >
        BigInt(this.authorization.maxCostMicrousd) - current.chargedCostMicrousd
    ) {
      throw new Error("campaign attempt/token/cost budget exhausted");
    }
    this.attempts.push({
      key,
      usage: null,
      state: "intent",
      chargedTokens: BigInt(this.limits.maxTokens),
      chargedCostMicrousd: BigInt(this.limits.maxCostMicrousd),
    });
    return structuredClone(this.limits);
  }

  settle(key: string, usage: MemoryAttemptUsage | null): void {
    const attempt = this.attempts.find((item) => item.key === key);
    if (!attempt || attempt.state !== "intent") throw new Error("unreserved or settled attempt");
    attempt.usage = structuredClone(usage);
    const counters = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheCreate];
    const valid = (value: number | null) =>
      value !== null && Number.isSafeInteger(value) && value >= 0;
    const knownSubtotal = (counters ?? []).reduce<bigint>(
      (sum, value) => sum + (valid(value) ? BigInt(value ?? 0) : 0n),
      0n,
    );
    const cost = usage?.costMicrousd ?? null;
    const knownCost = valid(cost) ? BigInt(cost ?? 0) : 0n;
    if (!counters?.every(valid) || !valid(cost)) {
      attempt.state = "unknown";
      // A missing input counter does not erase a known over-cap output/cache subtotal.
      // BigInt preserves exact lower bounds even when multiple safe counters overflow Number.
      if (knownSubtotal > attempt.chargedTokens) attempt.chargedTokens = knownSubtotal;
      if (knownCost > attempt.chargedCostMicrousd) attempt.chargedCostMicrousd = knownCost;
      this.blocked = "unknown or malformed usage; reserved ceiling retained, campaign stopped";
      return;
    }
    attempt.state = "settled";
    attempt.chargedTokens = knownSubtotal;
    attempt.chargedCostMicrousd = knownCost;
    if (
      knownSubtotal > BigInt(this.limits.maxTokens) ||
      knownCost > BigInt(this.limits.maxCostMicrousd)
    ) {
      this.blocked = "observed attempt exceeds its approved cap; campaign stopped";
    }
  }

  private totals() {
    return {
      chargedTokens: this.attempts.reduce((sum, attempt) => sum + attempt.chargedTokens, 0n),
      chargedCostMicrousd: this.attempts.reduce(
        (sum, attempt) => sum + attempt.chargedCostMicrousd,
        0n,
      ),
    };
  }

  snapshot() {
    const numeric = (value: bigint): number | null =>
      value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    const totals = this.totals();
    return structuredClone({
      attempts: this.attempts.map((attempt) => ({
        ...attempt,
        chargedTokens: numeric(attempt.chargedTokens),
        chargedTokensExact: attempt.chargedTokens.toString(),
        chargedCostMicrousd: numeric(attempt.chargedCostMicrousd),
        chargedCostMicrousdExact: attempt.chargedCostMicrousd.toString(),
      })),
      chargedTokens: numeric(totals.chargedTokens),
      chargedTokensExact: totals.chargedTokens.toString(),
      chargedCostMicrousd: numeric(totals.chargedCostMicrousd),
      chargedCostMicrousdExact: totals.chargedCostMicrousd.toString(),
      blocked: this.blocked,
    });
  }
}
