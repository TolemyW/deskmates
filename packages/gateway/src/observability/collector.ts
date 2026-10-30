// The observability collector (ADR-0046 decision 2): ledger → spool → batch → sink, one way.
//
// A tick reads the ledger past the received cursor in short read transactions, appends what it
// found to the spool (rows and cursor in one fsynced chunk), closes the open batch once it is
// `batchSeconds` old or `batchBytes` large, and hands every closed batch to the sink in order. The
// committed watermark moves, and the batch file goes, only when the sink reports every table of
// the batch committed; a batch that failed halfway is sent again whole, and the tables it already
// committed are no-ops under their tokens. A crash anywhere loses nothing (the spool holds it) and
// duplicates nothing (the cursor is in the spool with the rows, and commits are by token).

import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLES,
  type ObservabilityPayloadPolicy,
  type ObservabilitySinkRuntime,
  type ObservabilityTable,
  type ObservabilityTableStatus,
  observabilityCommitToken,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { cursorText } from "./cursor.js";
import { LedgerReader } from "./ledger-reader.js";
import { type Fault, Spool, type SpoolState } from "./spool.js";

/** How long one tick may keep reading a backlog before it lets the event loop go. */
export const TICK_READ_BUDGET_MS = 200;

export interface CollectorSettings {
  batchSeconds: number;
  batchBytes: number;
  payloads: ObservabilityPayloadPolicy;
}

export interface CollectorOptions {
  db: GatewayDb;
  sink: ObservabilitySinkRuntime;
  spoolDir: string;
  settings: CollectorSettings;
  now?: () => Date;
  /** T1 only: stop as if killed at a named point. */
  fault?: Fault;
  pageSize?: number;
}

export interface TickResult {
  /** The ledger had more than one tick could read: tick again soon. */
  backlog: boolean;
}

export class Collector {
  private readonly reader: LedgerReader;
  private readonly spool: Spool;
  private readonly now: () => Date;
  private state: SpoolState | undefined;

  constructor(private readonly opts: CollectorOptions) {
    this.reader = new LedgerReader(opts.db);
    this.spool = new Spool(opts.spoolDir, opts.fault);
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Recover the spool, prepare the sink, and refuse a sink that is ahead of the spool: that is a
   * spool lost or restored from an older copy, and reading the ledger again from the start would
   * duplicate every row the sink holds.
   */
  async init(): Promise<void> {
    if (this.opts.sink.manifest.contractVersion !== OBSERVABILITY_CONTRACT_VERSION)
      throw new Error(
        `observability sink ${this.opts.sink.manifest.id} speaks contract ${this.opts.sink.manifest.contractVersion}, not ${OBSERVABILITY_CONTRACT_VERSION}`,
      );
    await this.opts.sink.ensureSchema();
    const state = this.spool.recover();
    const known = [
      state.committed.batchId,
      ...state.closed.map((b) => b.batchId),
      state.open?.batchId ?? null,
    ].filter((id): id is string => id !== null);
    const localMax = known.length ? known.reduce((a, b) => (a > b ? a : b)) : null;
    const sinkMax = await this.opts.sink.lastCommitted();
    if (sinkMax !== null && (localMax === null || sinkMax > localMax))
      throw new Error(
        `the observability sink holds batch ${sinkMax}, which the spool in ${this.opts.spoolDir} does not know: the spool was lost or belongs to another sink. Move the sink's data aside to rebuild it from the ledger, or restore the spool.`,
      );
    this.state = state;
  }

  private get s(): SpoolState {
    if (!this.state) throw new Error("collector not initialised");
    return this.state;
  }

  /** One step; `close` closes the open batch after reading, whatever its age (a flush). */
  async tick(close = false): Promise<TickResult> {
    const started = Date.now();
    let backlog = false;
    for (;;) {
      const result = this.reader.read(this.s.received, {
        now: this.now(),
        payloads: this.opts.settings.payloads,
        ...(this.opts.pageSize ? { pageSize: this.opts.pageSize } : {}),
      });
      this.spool.append(result.rows, result.cursor, this.now());
      // A read with no rows may still move a cursor (an id no longer held back by a pruned row).
      // Nothing is spooled then; the next read recomputes the same move from the same rows.
      const open = this.s.open;
      if (open && open.bytes >= this.opts.settings.batchBytes) this.spool.close(this.now());
      backlog = result.more;
      if (!result.more || Date.now() - started >= TICK_READ_BUDGET_MS) break;
    }
    const open = this.s.open;
    if (
      open &&
      (close ||
        this.now().getTime() - Date.parse(open.openedAt) >= this.opts.settings.batchSeconds * 1000)
    )
      this.spool.close(this.now());
    await this.commitClosed();
    return { backlog };
  }

  /** Close the open batch now without reading (tests). */
  closeOpen(): void {
    this.spool.close(this.now());
  }

  private async commitClosed(): Promise<void> {
    for (const { batchId } of [...this.s.closed]) {
      const { batch, cursor } = this.spool.load(batchId);
      const expected = (Object.keys(batch.tables) as ObservabilityTable[]).map((table) =>
        observabilityCommitToken(table, batchId),
      );
      const { committed } = await this.opts.sink.writeBatch(batch);
      const missing = expected.filter((token) => !committed.includes(token));
      if (missing.length)
        throw new Error(`observability sink did not commit ${missing.join(", ")}; will resend`);
      this.opts.fault?.("commit.afterSink");
      this.spool.committed(batchId, cursor, this.now());
    }
  }

  tables(): ObservabilityTableStatus[] {
    const state = this.state;
    return OBSERVABILITY_TABLES.map((table) => ({
      table,
      received: state ? cursorText(state.received, table) : null,
      committed: state ? cursorText(state.committed.cursor, table) : null,
    }));
  }

  spoolState(): Readonly<SpoolState> | undefined {
    return this.state;
  }

  spoolBytes(): number {
    return this.state ? this.spool.bytes() : 0;
  }
}
