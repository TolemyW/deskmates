// Failed sign-in throttling. A fixed window per login name and per client address: too many
// failures in the window refuse further attempts for that key until the window ends, whatever
// the password. In memory: a restart clears it, which costs an attacker a restart they cannot
// cause from outside.

export interface ThrottleLimits {
  windowMs: number;
  perLoginName: number;
  perAddress: number;
  /** Maximum retained keys; capacity pressure never discards live budgets or tickets. */
  maxKeys?: number;
}

export const LOGIN_THROTTLE_DEFAULTS: Readonly<ThrottleLimits> = {
  windowMs: 15 * 60 * 1000,
  perLoginName: 5,
  perAddress: 30,
  maxKeys: 10_000,
};

interface Bucket {
  failures: number;
  /** Admitted attempts whose verification has not finished; they spend budget too. */
  pending: number;
  windowEnds: number;
}

/** An admitted attempt. Only its first outcome counts; later calls are ignored. */
export interface ThrottleTicket {
  /** A wrong credential: spends one unit of every key's budget for the window. */
  failed(): void;
  /** The credential was right: also clears the login name's earlier failures. */
  succeeded(): void;
  /** Neither (invalid input, a lost race, an internal error): frees the reservation only. */
  released(): void;
}

/** While only in-flight attempts fill the budget, ask the caller to retry this soon. */
const PENDING_RETRY_MS = 1000;

/** Never evict a live failure window or an in-flight reservation to admit a new key. */
const MAX_BUCKETS = 10_000;

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private nextPruneAt = 0;

  constructor(
    private readonly limits: ThrottleLimits = LOGIN_THROTTLE_DEFAULTS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private keys(loginName: string, address: string): Array<[string, number]> {
    return [
      [`login:${loginName}`, this.limits.perLoginName],
      [`addr:${address}`, this.limits.perAddress],
    ];
  }

  /** The bucket for a key; an expired window restarts with its in-flight attempts kept. */
  private bucket(key: string): Bucket {
    const now = this.clock().getTime();
    const current = this.buckets.get(key);
    if (current && current.windowEnds > now) return current;
    const fresh = {
      failures: 0,
      pending: current?.pending ?? 0,
      windowEnds: now + this.limits.windowMs,
    };
    this.buckets.set(key, fresh);
    return fresh;
  }

  /** Number of keys held; for tests and diagnostics. */
  get size(): number {
    return this.buckets.size;
  }

  /** Milliseconds until another attempt would be admitted; 0 when one would be now. */
  retryAfterMs(loginName: string, address: string): number {
    const now = this.clock().getTime();
    let wait = 0;
    for (const [key, limit] of this.keys(loginName, address)) {
      // A refused request must not allocate buckets for attacker-controlled fresh names.
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      const failures = bucket.windowEnds > now ? bucket.failures : 0;
      if (failures >= limit) wait = Math.max(wait, bucket.windowEnds - now);
      else if (failures + bucket.pending >= limit) wait = Math.max(wait, PENDING_RETRY_MS);
    }
    if (wait > 0) return wait;
    const missing = (): number =>
      this.keys(loginName, address).filter(([key]) => !this.buckets.has(key)).length;
    const maxKeys = this.limits.maxKeys ?? MAX_BUCKETS;
    if (this.buckets.size + missing() > maxKeys) {
      this.prune();
      // Reserve space for both keys atomically, or fail closed without allocating either.
      if (this.buckets.size + missing() > maxKeys) return PENDING_RETRY_MS;
    }
    return wait;
  }

  /**
   * Admit one attempt, or refuse it, before any password work starts. An admitted attempt holds
   * one unit of every key's budget until its ticket settles, so concurrent attempts cannot all
   * pass the check while the earlier ones are still hashing.
   */
  admit(loginName: string, address: string): { ticket: ThrottleTicket } | { retryAfterMs: number } {
    const wait = this.retryAfterMs(loginName, address);
    if (wait > 0) return { retryAfterMs: wait };
    const keys = this.keys(loginName, address).map(([key]) => key);
    for (const key of keys) this.bucket(key).pending += 1;
    let settled = false;
    const settle = (outcome: "failed" | "succeeded" | "released"): void => {
      if (settled) return;
      settled = true;
      for (const key of keys) {
        const bucket = this.bucket(key);
        bucket.pending = Math.max(0, bucket.pending - 1);
        if (outcome === "failed") bucket.failures += 1;
      }
      // A success clears the login name's failures; the address keeps its count for the window.
      if (outcome === "succeeded") {
        const login = this.buckets.get(keys[0] as string);
        if (login) login.failures = 0;
      }
      for (const key of keys) {
        const bucket = this.buckets.get(key);
        if (bucket && bucket.pending === 0 && bucket.failures === 0) this.buckets.delete(key);
      }
    };
    return {
      ticket: {
        failed: () => settle("failed"),
        succeeded: () => settle("succeeded"),
        released: () => settle("released"),
      },
    };
  }

  /** Reclaim expired windows only: live failure budgets and active tickets stay intact. */
  private prune(): void {
    const now = this.clock().getTime();
    // Capacity pressure is attacker-controlled too: scan at most once per retry interval.
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + PENDING_RETRY_MS;
    for (const [key, bucket] of this.buckets)
      if (bucket.pending === 0 && bucket.windowEnds <= now) this.buckets.delete(key);
  }
}
