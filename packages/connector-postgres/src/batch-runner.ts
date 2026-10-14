// Runs accepted receipts one at a time, in submit order, like the host adapter did: one batch at
// a time keeps the load on the database predictable and the receipts easy to reconcile. Each
// run appends `running`, records every statement outcome as it happens, then appends `succeeded`
// (every statement reached a definite outcome, `ok` or `error`) or `failed` (anything uncertain,
// not run, or a case that could not connect).
//
// On start, `recover` finishes what a previous process left: an `accepted` receipt had sent
// nothing and is queued again; a `running` one is failed without resending anything, its next
// unrecorded statement marked `uncertain` (it may have been in flight) and the rest `not_run`.

import type { ConnectorLimits } from "./config.js";
import { executeBatch } from "./execute-batch.js";
import type { ReceiptStore } from "./receipt-store.js";
import type { SqlSessionFactory } from "./sql-session.js";
import {
  type CaseResult,
  type StatementResult,
  batchSucceeded,
  outcomeCounts,
} from "./statement-result.js";
import type { SqlBatch } from "./submission.js";

export interface BatchRunnerDeps {
  store: ReceiptStore;
  sessions: SqlSessionFactory;
  limits: Pick<ConnectorLimits, "resultRowsPerStatement" | "statementTimeoutMs">;
  secrets?: string[];
  graceMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function resultSummary(batch: SqlBatch, cases: CaseResult[]): string {
  const c = outcomeCounts(cases);
  const total = c.ok + c.error + c.uncertain + c.not_run;
  return `batch ${batch.batch_id}: ${total} statements: ${c.ok} ok, ${c.error} error, ${c.uncertain} uncertain, ${c.not_run} not run`;
}

export class BatchRunner {
  private readonly queue: string[] = [];
  private active: Promise<void> | undefined;

  constructor(private readonly deps: BatchRunnerDeps) {}

  enqueue(receiptId: string): void {
    this.queue.push(receiptId);
    this.pump();
  }

  /** Resolves when the queue is empty and nothing runs. */
  async whenIdle(): Promise<void> {
    while (this.active) await this.active;
  }

  recover(): void {
    for (const { receiptId, status } of this.deps.store.unfinished()) {
      if (status === "accepted") {
        this.enqueue(receiptId);
        continue;
      }
      const batch = this.deps.store.batchOf(receiptId);
      const cases = interrupted(batch, this.deps.store.recordedCases(receiptId));
      this.deps.store.appendVersion(
        receiptId,
        "failed",
        `the connector stopped during execution; nothing was resent. ${resultSummary(batch, cases)}`,
        cases,
        `/receipt/${receiptId}`,
      );
    }
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.active = this.run(next).finally(() => {
      this.active = undefined;
      this.pump();
    });
  }

  private async run(receiptId: string): Promise<void> {
    const { store } = this.deps;
    const batch = store.batchOf(receiptId);
    store.appendVersion(receiptId, "running", `batch ${batch.batch_id}: running`);
    let cases: CaseResult[];
    try {
      cases = await executeBatch(batch, {
        sessions: this.deps.sessions,
        limits: this.deps.limits,
        onStatement: (caseIndex, r) => store.recordStatement(receiptId, caseIndex, r),
        onConnectError: (caseIndex, e) => store.recordConnectError(receiptId, caseIndex, e),
        ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
        ...(this.deps.graceMs === undefined ? {} : { graceMs: this.deps.graceMs }),
      });
    } catch (err) {
      // Not a database outcome: a defect in this service. What was recorded stays recorded.
      this.deps.log?.("batch execution failed", {
        receiptId,
        error: err instanceof Error ? err.name : "error",
      });
      cases = interrupted(batch, store.recordedCases(receiptId));
      store.appendVersion(
        receiptId,
        "failed",
        `the connector failed during execution; nothing was resent. ${resultSummary(batch, cases)}`,
        cases,
        `/receipt/${receiptId}`,
      );
      return;
    }
    store.appendVersion(
      receiptId,
      batchSucceeded(cases) ? "succeeded" : "failed",
      resultSummary(batch, cases),
      cases,
      `/receipt/${receiptId}`,
    );
  }
}

/**
 * Completes recorded outcomes of an interrupted run: the first unrecorded statement is
 * `uncertain` (it may have been sent), everything after it `not_run`.
 */
export function interrupted(batch: SqlBatch, recorded: CaseResult[]): CaseResult[] {
  let inFlightMarked = false;
  return batch.cases.map((c) => {
    const have = recorded.find((r) => r.caseId === c.id);
    if (have?.connectError) {
      return {
        caseId: c.id,
        connectError: have.connectError,
        statements: c.steps.map((sql, index) => notRun(index, sql)),
      };
    }
    const statements: StatementResult[] = c.steps.map((sql, index) => {
      const done = have?.statements.find((s) => s.index === index);
      if (done) return done;
      if (!inFlightMarked) {
        inFlightMarked = true;
        return {
          index,
          sql,
          ok: false,
          outcome: "uncertain",
          error: {
            sqlstate: null,
            message: "the connector stopped while this statement may have been running",
          },
          durationMs: 0,
        };
      }
      return notRun(index, sql);
    });
    return { caseId: c.id, statements };
  });
}

const notRun = (index: number, sql: string): StatementResult => ({
  index,
  sql,
  ok: false,
  outcome: "not_run",
  durationMs: 0,
});
