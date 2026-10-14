import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PhaseTimingSample, TimingPhase } from "@deskmates/contracts";

export type TimingOutcome = "ok" | "error" | "cancelled";

export interface TimingSpan {
  readonly spanId: string;
  end(outcome?: TimingOutcome): void;
}

export interface TimingRecorder {
  start(phase: TimingPhase, options?: { parentSpanId?: string; toolName?: string }): TimingSpan;
}

export interface PhaseTimerOptions {
  emit(sample: PhaseTimingSample): void;
  now?: () => Date;
  monotonicNow?: () => number;
  id?: () => string;
}

export class PhaseTimer implements TimingRecorder {
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly id: () => string;

  constructor(private readonly options: PhaseTimerOptions) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.id = options.id ?? randomUUID;
  }

  start(
    phase: TimingPhase,
    options: { parentSpanId?: string; toolName?: string } = {},
  ): TimingSpan {
    let spanId: string;
    let started: number;
    try {
      spanId = this.id();
      started = this.monotonicNow();
      this.safeEmit({
        source: "phase_timing",
        version: 1,
        spanId,
        phase,
        edge: "start",
        at: this.now().toISOString(),
        ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
        ...(options.toolName ? { toolName: options.toolName } : {}),
      });
    } catch {
      return { spanId: "", end: () => {} };
    }
    let ended = false;
    return {
      spanId,
      end: (outcome = "ok") => {
        if (ended) return;
        ended = true;
        try {
          this.safeEmit({
            source: "phase_timing",
            version: 1,
            spanId,
            phase,
            edge: "end",
            at: this.now().toISOString(),
            durationMs: Math.max(0, this.monotonicNow() - started),
            outcome,
            ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
            ...(options.toolName ? { toolName: options.toolName } : {}),
          });
        } catch {}
      },
    };
  }

  private safeEmit(sample: PhaseTimingSample): void {
    try {
      this.options.emit(sample);
    } catch {}
  }
}

export interface TimingBufferOptions {
  deliver(samples: readonly PhaseTimingSample[]): Promise<void>;
  maxSamples?: number;
  batchSize?: number;
  log?: (message: string) => void;
}

/** A bounded, one-way telemetry queue. Delivery never participates in browser tool promises. */
export class TimingBuffer {
  private readonly maxSamples: number;
  private readonly batchSize: number;
  private readonly log: (message: string) => void;
  private pending: PhaseTimingSample[] = [];
  private inFlight: Promise<void> | undefined;
  private scheduled = false;
  private dropped = 0;

  constructor(private readonly options: TimingBufferOptions) {
    this.maxSamples = options.maxSamples ?? 256;
    this.batchSize = options.batchSize ?? 32;
    this.log = options.log ?? (() => {});
  }

  emit = (sample: PhaseTimingSample): void => {
    if (this.pending.length >= this.maxSamples) {
      this.dropped++;
      return;
    }
    this.pending.push(sample);
    this.schedule();
  };

  private schedule(): void {
    if (this.scheduled || this.inFlight) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.batchSize);
    this.inFlight = Promise.resolve()
      .then(() => this.options.deliver(batch))
      .catch(() => this.safeLog("mcp-proxy: phase timing delivery failed"))
      .finally(() => {
        this.inFlight = undefined;
        if (this.dropped > 0) {
          this.safeLog(`mcp-proxy: dropped ${this.dropped} phase timing samples`);
          this.dropped = 0;
        }
        this.schedule();
      });
  }

  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.scheduled = false;
    this.pump();
    while ((this.inFlight || this.pending.length > 0) && Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      if (!this.inFlight) this.pump();
      await this.waitBounded(this.inFlight ?? Promise.resolve(), remaining);
    }
  }

  private async waitBounded(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private safeLog(message: string): void {
    try {
      this.log(message);
    } catch {}
  }
}
