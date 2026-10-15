// `operation_requests` (ADR-0040 decision 8): one row per forwarded or refused operation.

import type {
  LookMode,
  OperationMeasured,
  OperationName,
  OperationUnit,
  RunId,
} from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export interface OperationRecordInput {
  workspaceId: string;
  runId: RunId;
  attempt: number;
  operation: OperationName;
  mode: LookMode | null;
  model: string;
  endpointSha256: string;
  status: "succeeded" | "failed" | "refused";
  errorCode: string | null;
  unit: OperationUnit;
  quantity: number | null;
  measured: OperationMeasured;
  inputBytes: number;
  inputSha256: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

export interface OperationRecordRow {
  id: string;
  workspace_id: string;
  run_id: string;
  attempt: number;
  operation: OperationName;
  mode: LookMode | null;
  model: string;
  endpoint_sha256: string;
  status: "succeeded" | "failed" | "refused";
  error_code: string | null;
  unit: OperationUnit;
  quantity: number | null;
  measured: OperationMeasured;
  input_bytes: number;
  input_sha256: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  created_at: string;
}

export class OperationStore {
  constructor(private readonly db: GatewayDb) {}

  record(input: OperationRecordInput): string {
    const id = newId("op");
    this.db
      .prepare(
        `INSERT INTO operation_requests
           (id, workspace_id, run_id, attempt, operation, mode, model, endpoint_sha256, status,
            error_code, unit, quantity, measured, input_bytes, input_sha256, input_tokens,
            output_tokens, latency_ms, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.runId,
        input.attempt,
        input.operation,
        input.mode,
        input.model,
        input.endpointSha256,
        input.status,
        input.errorCode,
        input.unit,
        input.quantity,
        input.measured,
        input.inputBytes,
        input.inputSha256,
        input.inputTokens,
        input.outputTokens,
        input.latencyMs,
        input.costUsd,
        nowIso(),
      );
    return id;
  }

  forRun(runId: RunId): OperationRecordRow[] {
    return this.db
      .prepare("SELECT * FROM operation_requests WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as OperationRecordRow[];
  }
}
