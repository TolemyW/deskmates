// The exact memory a run was given (ADR-0011 decision 12 and amendment 2, A13): every (entry,
// version) that reached its model context through the pinned index or a `memory_search` result.
// Rows are only ever added; a later supersession changes entries, never what a run received.

import type { MemorySupplyVia, MemoryVersionRef, RunId, WorkspaceId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export interface SuppliedVersion extends MemoryVersionRef {
  via: MemorySupplyVia;
  suppliedAt: string;
}

export class RunMemorySupply {
  constructor(private readonly db: GatewayDb) {}

  record(
    workspaceId: WorkspaceId,
    runId: RunId,
    refs: readonly MemoryVersionRef[],
    via: MemorySupplyVia,
    at: string = nowIso(),
  ): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO run_memory_versions (workspace_id, run_id, entry_id, version, via,
         supplied_at) VALUES (?,?,?,?,?,?)`,
    );
    this.db.transaction(() => {
      for (const ref of refs) insert.run(workspaceId, runId, ref.entryId, ref.version, via, at);
    })();
  }

  list(workspaceId: WorkspaceId, runId: RunId): SuppliedVersion[] {
    const rows = this.db
      .prepare(
        `SELECT entry_id, version, via, supplied_at FROM run_memory_versions WHERE workspace_id = ? AND run_id = ?
         ORDER BY supplied_at, via, entry_id, version`,
      )
      .all(workspaceId, runId) as {
      entry_id: string;
      version: number;
      via: MemorySupplyVia;
      supplied_at: string;
    }[];
    return rows.map((row) => ({
      entryId: row.entry_id,
      version: row.version,
      via: row.via,
      suppliedAt: row.supplied_at,
    }));
  }
}
