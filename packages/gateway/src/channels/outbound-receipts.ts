// The ABI-2 send gate's record (ADR-0047 decisions 9 and 10): one receipt per relayed message of
// a channel thread, carrying the connection, binding generation and credential generation it was
// decided under. A rebind or disconnect fence writes `cancelled` for every message not yet sent,
// so the gate refuses it afterwards and the record says what never went out.

import { channelAuthorId } from "@deskmates/contracts";
import { newId, nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export type ReceiptState = "sent" | "cancelled" | "blocked";

export interface OutboundReceipt {
  threadId: string;
  seq: number;
  connectionId?: string;
  bindingGeneration: number;
  credentialGeneration: number;
  state: ReceiptState;
  providerMessageId?: string;
  chunkCount: number;
  reason?: string;
}

interface ReceiptRow {
  thread_id: string;
  message_seq: number;
  connection_id: string | null;
  binding_generation: number;
  credential_generation: number;
  state: ReceiptState;
  provider_message_id: string | null;
  chunk_count: number;
  reason: string | null;
}

function toReceipt(row: ReceiptRow): OutboundReceipt {
  return {
    threadId: row.thread_id,
    seq: row.message_seq,
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
    bindingGeneration: row.binding_generation,
    credentialGeneration: row.credential_generation,
    state: row.state,
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    chunkCount: row.chunk_count,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

export interface ReceiptScope {
  workspaceId: string;
  connectionId: string;
  bindingGeneration: number;
  credentialGeneration: number;
}

export class OutboundReceipts {
  constructor(private readonly db: GatewayDb) {}

  get(threadId: string, seq: number): OutboundReceipt | undefined {
    const row = this.db
      .prepare("SELECT * FROM channel_outbound_receipts WHERE thread_id = ? AND message_seq = ?")
      .get(threadId, seq) as ReceiptRow | undefined;
    return row ? toReceipt(row) : undefined;
  }

  forThread(threadId: string): OutboundReceipt[] {
    return (
      this.db
        .prepare("SELECT * FROM channel_outbound_receipts WHERE thread_id = ? ORDER BY message_seq")
        .all(threadId) as ReceiptRow[]
    ).map(toReceipt);
  }

  /** Record a decision for one message; the first receipt of a message stands. */
  record(
    scope: ReceiptScope,
    input: {
      threadId: string;
      seq: number;
      state: ReceiptState;
      providerMessageId?: string;
      chunkCount?: number;
      reason?: string;
    },
  ): OutboundReceipt {
    this.db
      .prepare(
        `INSERT INTO channel_outbound_receipts
           (id, workspace_id, thread_id, message_seq, connection_id, binding_generation,
            credential_generation, state, provider_message_id, chunk_count, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, message_seq) DO NOTHING`,
      )
      .run(
        newId("chr"),
        scope.workspaceId,
        input.threadId,
        input.seq,
        scope.connectionId,
        scope.bindingGeneration,
        scope.credentialGeneration,
        input.state,
        input.providerMessageId ?? null,
        input.chunkCount ?? 0,
        input.reason ?? null,
        nowIso(),
      );
    return this.get(input.threadId, input.seq) as OutboundReceipt;
  }

  /**
   * The fence: every message of `threads` that is not the person's own and has no receipt is
   * recorded `cancelled` with `reason`. Returns how many were cancelled.
   */
  cancelUnsent(
    scope: Omit<ReceiptScope, "bindingGeneration">,
    channel: string,
    threads: readonly { id: string; bindingGeneration: number }[],
    reason: string,
  ): number {
    let cancelled = 0;
    const unsent = this.db.prepare(
      `SELECT m.seq FROM thread_messages m
        WHERE m.thread_id = ?
          AND NOT (m.author_kind = 'human' AND substr(m.author_id, 1, ?) = ?)
          AND NOT EXISTS (SELECT 1 FROM channel_outbound_receipts r
                           WHERE r.thread_id = m.thread_id AND r.message_seq = m.seq)
        ORDER BY m.seq`,
    );
    const prefix = channelAuthorId(channel, "");
    for (const thread of threads) {
      const rows = unsent.all(thread.id, prefix.length, prefix) as { seq: number }[];
      for (const row of rows) {
        this.record(
          { ...scope, bindingGeneration: thread.bindingGeneration },
          { threadId: thread.id, seq: row.seq, state: "cancelled", reason },
        );
        cancelled += 1;
      }
    }
    return cancelled;
  }
}
