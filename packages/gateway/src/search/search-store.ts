// `search_requests` (ADR-0049 decision 11): one row per search the proxy forwarded or refused.
// The query is a hash and a length; no query text, result, URL or credential is stored.

import type { RunId } from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export type SearchStatus = "succeeded" | "failed" | "refused";

export interface SearchRecordInput {
  workspaceId: string;
  runId: RunId;
  attempt: number;
  endpointSha256: string;
  status: SearchStatus;
  errorCode: string | null;
  querySha256: string | null;
  queryChars: number;
  redacted: boolean;
  language: string | null;
  maxResults: number | null;
  resultCount: number | null;
  droppedCount: number | null;
  latencyMs: number | null;
}

export interface SearchRecordRow {
  id: string;
  workspace_id: string;
  run_id: string;
  attempt: number;
  endpoint_sha256: string;
  status: SearchStatus;
  error_code: string | null;
  query_sha256: string | null;
  query_chars: number;
  is_redacted: number;
  language: string | null;
  max_results: number | null;
  result_count: number | null;
  dropped_count: number | null;
  latency_ms: number | null;
  created_at: string;
}

export class SearchStore {
  constructor(private readonly db: GatewayDb) {}

  record(input: SearchRecordInput): string {
    const id = newId("srch");
    this.db
      .prepare(
        `INSERT INTO search_requests
           (id, workspace_id, run_id, attempt, endpoint_sha256, status, error_code, query_sha256,
            query_chars, is_redacted, language, max_results, result_count, dropped_count,
            latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.runId,
        input.attempt,
        input.endpointSha256,
        input.status,
        input.errorCode,
        input.querySha256,
        input.queryChars,
        input.redacted ? 1 : 0,
        input.language,
        input.maxResults,
        input.resultCount,
        input.droppedCount,
        input.latencyMs,
        nowIso(),
      );
    return id;
  }

  /** Searches of the run that reached the service (succeeded or failed), every attempt. */
  forwardedCount(runId: RunId): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM search_requests WHERE run_id = ? AND status <> 'refused'",
        )
        .get(runId) as { n: number }
    ).n;
  }

  forRun(runId: RunId): SearchRecordRow[] {
    return this.db
      .prepare("SELECT * FROM search_requests WHERE run_id = ? ORDER BY created_at, rowid")
      .all(runId) as SearchRecordRow[];
  }
}
