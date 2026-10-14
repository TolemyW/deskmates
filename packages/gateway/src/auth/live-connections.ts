// Long-lived connections opened under a browser session: the SSE feed and screen WebSockets.
// A request is re-authenticated every time, but a stream is authenticated once at open, so
// revocation must reach it explicitly. Revocation inside this process closes the session's
// connections at once; a periodic sweep re-checks every registered session so a revocation
// written by another process (the maintenance CLI) or an expiry also closes them within one
// sweep interval. A connection opened in a tenant is re-checked against that tenant, so losing
// one membership closes that tenant's streams and leaves the session's other tenants alone.

export const LIVE_SWEEP_MS_DEFAULT = 15_000;

export class LiveConnections {
  /** Per session: each connection's close function and the tenant it was opened in. */
  private readonly bySession = new Map<string, Map<() => void, string | undefined>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    /** Whether a session may keep its connections (in a tenant); false closes them. */
    private readonly stillAuthorized: (sessionId: string, tenantId?: string) => boolean,
    private readonly sweepMs: number = LIVE_SWEEP_MS_DEFAULT,
  ) {}

  /** Register a connection's close function; the returned function unregisters it. */
  register(sessionId: string, close: () => void, tenantId?: string): () => void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Map();
      this.bySession.set(sessionId, set);
    }
    set.set(close, tenantId);
    this.ensureSweep();
    return () => {
      const current = this.bySession.get(sessionId);
      if (!current) return;
      current.delete(close);
      if (current.size === 0) this.bySession.delete(sessionId);
      if (this.bySession.size === 0) this.stopSweep();
    };
  }

  /** Close every connection of these sessions now. Returns how many were closed. */
  closeSessions(sessionIds: Iterable<string>): number {
    let closed = 0;
    for (const id of sessionIds) {
      const set = this.bySession.get(id);
      if (!set) continue;
      this.bySession.delete(id);
      for (const close of set.keys()) closed += this.closeOne(close);
    }
    if (this.bySession.size === 0) this.stopSweep();
    return closed;
  }

  /**
   * Re-check every registered connection against its session and tenant and close the ones no
   * longer authorized. Call it right after an in-process membership or tenant change.
   */
  sweep(): number {
    let closed = 0;
    for (const [sessionId, set] of [...this.bySession]) {
      const verdicts = new Map<string | undefined, boolean>();
      for (const [close, tenantId] of [...set]) {
        let ok = verdicts.get(tenantId);
        if (ok === undefined) {
          ok = this.stillAuthorized(sessionId, tenantId);
          verdicts.set(tenantId, ok);
        }
        if (ok) continue;
        set.delete(close);
        closed += this.closeOne(close);
      }
      if (set.size === 0) this.bySession.delete(sessionId);
    }
    if (this.bySession.size === 0) this.stopSweep();
    return closed;
  }

  private closeOne(close: () => void): number {
    try {
      close();
    } catch {
      // A connection that fails to close is already going away.
    }
    return 1;
  }

  count(sessionId?: string): number {
    if (sessionId !== undefined) return this.bySession.get(sessionId)?.size ?? 0;
    let n = 0;
    for (const set of this.bySession.values()) n += set.size;
    return n;
  }

  stop(): void {
    this.stopSweep();
  }

  private ensureSweep(): void {
    if (this.timer !== undefined || this.sweepMs <= 0) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref();
  }

  private stopSweep(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
