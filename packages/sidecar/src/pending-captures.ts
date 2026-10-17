// Screenshot captures in flight (issue #9). Pairing a page-changing action with its capture may
// wait up to SCREENSHOT_WAIT_MS for the proxy's file; that wait used to sit inside the SDK message
// loop and delayed every message behind it. Each capture now runs on its own and is collected
// here, so the run can settle them all before it removes the capture directory and flushes.

export class PendingCaptures {
  private readonly pending = new Set<Promise<void>>();

  /** `onError` reports a capture that threw; a capture can never fail the run. */
  constructor(private readonly onError: (err: unknown) => void) {}

  add(capture: Promise<void>): void {
    const tracked = capture.catch((err: unknown) => this.onError(err));
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once every capture added so far, and any added meanwhile, has finished. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
