import { randomUUID } from "node:crypto";
import {
  PHASE_TIMING_VERSION,
  type PhaseTimingSample,
  type TimingPhase,
} from "@deskmates/contracts";

export type TimingRecorder = (sample: PhaseTimingSample) => unknown;

export interface ModelTransportTimingOptions {
  record?: TimingRecorder;
  requestKind?: PhaseTimingSample["requestKind"];
  /** The model the request goes upstream for; named on every span (ADR-0046 amendment 2). */
  model?: string;
  wallNow?: () => Date;
  monotonicNow?: () => number;
  spanId?: () => string;
}

type TimingOutcome = NonNullable<PhaseTimingSample["outcome"]>;

interface OpenSpan {
  id: string;
  phase: TimingPhase;
  startedAt: number;
  parentSpanId?: string;
  ended: boolean;
}

/**
 * Records overlapping transport spans for one upstream request. These spans are nested
 * observations and must not be added together. Recorder failures are deliberately isolated from
 * the model byte stream.
 */
export class ModelTransportTiming {
  private readonly record: TimingRecorder | undefined;
  private readonly wallNow: () => Date;
  private readonly monotonicNow: () => number;
  private readonly nextSpanId: () => string;
  private readonly requestKind?: PhaseTimingSample["requestKind"];
  private readonly model?: string;
  private readonly request: OpenSpan;
  private readonly headers: OpenSpan;
  private readonly firstByte: OpenSpan;
  private body?: OpenSpan;

  constructor(opts: ModelTransportTimingOptions = {}) {
    this.record = opts.record;
    this.wallNow = opts.wallNow ?? (() => new Date());
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());
    this.nextSpanId = opts.spanId ?? randomUUID;
    this.requestKind = opts.requestKind;
    if (opts.model) this.model = opts.model;

    this.request = this.start("model_request");
    this.headers = this.start("model_headers", this.request.id);
    this.firstByte = this.start("model_first_byte", this.request.id);
  }

  receivedHeaders(): void {
    this.end(this.headers, "ok");
    if (!this.body) this.body = this.start("model_body", this.request.id);
  }

  receivedBytes(byteLength: number): void {
    if (byteLength > 0) this.end(this.firstByte, "ok");
  }

  completed(): void {
    // A response may validly contain no body bytes. That is an absent first-byte observation,
    // represented as cancelled rather than a fabricated zero-duration sample.
    this.end(this.firstByte, "cancelled");
    if (this.body) this.end(this.body, "ok");
    this.end(this.request, "ok");
  }

  failed(): void {
    this.end(this.headers, "error");
    this.end(this.firstByte, "error");
    if (this.body) this.end(this.body, "error");
    this.end(this.request, "error");
  }

  cancelled(): void {
    this.end(this.headers, "cancelled");
    this.end(this.firstByte, "cancelled");
    if (this.body) this.end(this.body, "cancelled");
    this.end(this.request, "cancelled");
  }

  private start(phase: TimingPhase, parentSpanId?: string): OpenSpan {
    const span: OpenSpan = {
      id: this.nextSpanId(),
      phase,
      startedAt: this.monotonicNow(),
      ended: false,
      ...(parentSpanId ? { parentSpanId } : {}),
    };
    this.emit({
      source: "phase_timing",
      version: PHASE_TIMING_VERSION,
      spanId: span.id,
      phase,
      edge: "start",
      at: this.wallNow().toISOString(),
      ...(parentSpanId ? { parentSpanId } : {}),
      ...(this.requestKind ? { requestKind: this.requestKind } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
    return span;
  }

  private end(span: OpenSpan, outcome: TimingOutcome): void {
    if (span.ended) return;
    span.ended = true;
    this.emit({
      source: "phase_timing",
      version: PHASE_TIMING_VERSION,
      spanId: span.id,
      phase: span.phase,
      edge: "end",
      at: this.wallNow().toISOString(),
      durationMs: Math.max(0, this.monotonicNow() - span.startedAt),
      outcome,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      ...(this.requestKind ? { requestKind: this.requestKind } : {}),
      ...(this.model ? { model: this.model } : {}),
    });
  }

  private emit(sample: PhaseTimingSample): void {
    if (!this.record) return;
    try {
      const result = this.record(sample);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Timing is observational. A ledger or observer failure must never break model transport.
    }
  }
}
