// A connection's sender blocklist (ADR-0047 decision 13): ABI-2 connections admit every sender
// unless blocked. The host consults it on every inbound message and before every send, so a
// blocked sender is dropped in both directions; unblocking replays nothing.

import {
  CHANNEL_SENDER_ID_MAX,
  type ChannelSenderBlock,
  DeskmatesError,
  type WorkspaceId,
  channelAuthorId,
  isExternalRef,
} from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

interface BlockRow {
  connection_id: string;
  sender_id: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

const NOTE_MAX = 200;

function toBlock(row: BlockRow): ChannelSenderBlock {
  return {
    connectionId: row.connection_id,
    senderId: row.sender_id,
    ...(row.note ? { note: row.note } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** A provider sender id as an operator typed it: trimmed, printable, bounded. */
export function parseSenderId(value: unknown): string {
  const senderId = typeof value === "string" ? value.trim() : "";
  if (!isExternalRef(senderId) || senderId.length > CHANNEL_SENDER_ID_MAX)
    throw new DeskmatesError("validation", "senderId must be the provider's id for the person", {
      field: "senderId",
    });
  return senderId;
}

export class SenderBlocks {
  constructor(private readonly db: GatewayDb) {}

  list(connectionId: string): ChannelSenderBlock[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM channel_sender_blocks WHERE connection_id = ? ORDER BY created_at, sender_id",
        )
        .all(connectionId) as BlockRow[]
    ).map(toBlock);
  }

  isBlocked(connectionId: string, senderId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM channel_sender_blocks WHERE connection_id = ? AND sender_id = ?")
        .get(connectionId, senderId) !== undefined
    );
  }

  /** Whether a person who wrote in `threadId` through `channel` is blocked on the connection. */
  threadBlocked(connectionId: string, channel: string, threadId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM channel_sender_blocks b
            WHERE b.connection_id = ?
              AND EXISTS (SELECT 1 FROM thread_messages m
                           WHERE m.thread_id = ? AND m.author_kind = 'human'
                             AND m.author_id = ? || b.sender_id)`,
        )
        .get(connectionId, threadId, channelAuthorId(channel, "")) !== undefined
    );
  }

  /** Add an entry; adding one that exists keeps the first and returns it. */
  add(input: {
    workspaceId: WorkspaceId;
    connectionId: string;
    senderId: string;
    note?: string;
    createdBy: string;
  }): { block: ChannelSenderBlock; created: boolean } {
    const note = input.note?.trim().slice(0, NOTE_MAX) || null;
    const changes = this.db
      .prepare(
        `INSERT INTO channel_sender_blocks
           (workspace_id, connection_id, sender_id, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (connection_id, sender_id) DO NOTHING`,
      )
      .run(
        input.workspaceId,
        input.connectionId,
        input.senderId,
        note,
        input.createdBy,
        nowIso(),
      ).changes;
    const row = this.db
      .prepare("SELECT * FROM channel_sender_blocks WHERE connection_id = ? AND sender_id = ?")
      .get(input.connectionId, input.senderId) as BlockRow;
    return { block: toBlock(row), created: changes > 0 };
  }

  remove(connectionId: string, senderId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM channel_sender_blocks WHERE connection_id = ? AND sender_id = ?")
        .run(connectionId, senderId).changes > 0
    );
  }
}
