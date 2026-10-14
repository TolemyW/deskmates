// Ledger event sink: every SDK message, hook decision and approval step becomes a `SidecarEvent`
// with a monotonic `seq`, redacted before it leaves the process, and posted to the Gateway in
// small batches so a chatty run does not make one HTTP call per token.

import {
  DeskmatesError,
  type RunEventKind,
  type RunId,
  type SidecarEvent,
} from "@deskmates/contracts";

export interface EventSinkOptions {
  runId: RunId;
  /**
   * `StartRunRequest.attempt`, echoed on every event. The counter below restarts at 1 in every
   * sidecar process, so `(run, seq)` alone cannot tell a resumed process's first event from a
   * redelivery of the first process's (ADR-0002 amendment 2, "Resume keeps the ledger whole").
   */
  attempt: number;
  post: (batch: readonly SidecarEvent[]) => Promise<void>;
  redact: (payload: Record<string, unknown>) => Record<string, unknown>;
  now: () => Date;
  /** Delay before a queued batch is sent; the final `flush()` sends whatever is left. */
  batchDelayMs?: number;
  /** Backoff between attempts for a batch whose post failed; tests shorten it. */
  batchRetryDelaysMs?: readonly number[];
  /** How to wait between retries; the sidecar passes `deps.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  onError?: (err: unknown) => void;
}

/** Backoff between ledger-batch posts: five attempts over about 15 s, as for `run_ended`. */
export const BATCH_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A refusal the Gateway made on the batch's merits (a 4xx with a Deskmates body: a stale attempt, a
 * revoked token) will be refused again; anything else (no connection, a 5xx, a proxy's page) may
 * be a restart in progress.
 */
function isPermanent(err: unknown): boolean {
  if (!(err instanceof DeskmatesError)) return false;
  const status = err.details.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

export class EventSink {
  private seq = 0;
  private queue: SidecarEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly batchDelayMs: number;
  /** A batch exhausted its backoff and no post has succeeded since. */
  private gatewayGone = false;
  /** Everything emitted, in order, for diagnostics. */
  readonly emitted: SidecarEvent[] = [];

  constructor(private readonly opts: EventSinkOptions) {
    this.batchDelayMs = opts.batchDelayMs ?? 200;
  }

  emit(kind: RunEventKind, payload: Record<string, unknown>): SidecarEvent {
    this.seq += 1;
    const event: SidecarEvent = {
      type: "event",
      runId: this.opts.runId,
      attempt: this.opts.attempt,
      seq: this.seq,
      kind,
      payload: this.opts.redact(payload),
      ts: this.opts.now().toISOString(),
    };
    this.emitted.push(event);
    this.queue.push(event);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, this.batchDelayMs);
    }
    return event;
  }

  private schedule(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.chain = this.chain.then(() => this.post(batch));
  }

  /**
   * One batch, retried on failure. A dropped batch is a permanent hole in the ledger, and what
   * drops batches in practice is transient: a Gateway restart while the run is live. The batch
   * keeps its place in the chain, so later batches wait behind it and order holds. A retry of a
   * batch the Gateway did store is harmless: it drops events it already holds by
   * `(run, attempt, seq)`.
   *
   * Once one batch has used its whole backoff the Gateway is treated as gone: later batches get
   * one attempt each until a post succeeds again, so a long outage cannot stack one backoff per
   * queued batch in front of `run_ended`.
   */
  private async post(batch: readonly SidecarEvent[]): Promise<void> {
    const delays = this.opts.batchRetryDelaysMs ?? BATCH_RETRY_DELAYS_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.opts.post(batch);
        this.gatewayGone = false;
        return;
      } catch (err) {
        const delay = delays[attempt];
        if (delay === undefined) this.gatewayGone = true;
        if (delay === undefined || this.gatewayGone || isPermanent(err)) {
          this.opts.onError?.(err);
          return;
        }
        await sleep(delay);
      }
    }
  }

  /** Send everything queued and wait for all in-flight batches. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule();
    await this.chain;
  }
}
