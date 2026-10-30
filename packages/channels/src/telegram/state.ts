// A Telegram connection's private state (ADR-0047 decisions 11 and 14): one JSON file in the
// connection's own state directory (0700, the file 0600), rewritten atomically. It holds the
// update offset and, per thread, the relay cursor and the chunks of a half-sent message. No
// credential is ever written here. The Gateway removes the directory on disconnect.
//
// - The update offset is identity-scoped (one bot), so it survives restart, reconnect, relink and
//   rebind: Telegram does not redeliver what was confirmed.
// - Relay cursors belong to one binding generation: after a rebind the old threads are fenced and
//   unreachable, so their cursors are dropped.
// - A half-sent message's chunk progress belongs to one credential generation: after a relink it
//   is discarded (ADR-0047 decision 8). The Gateway's receipts still keep a fully sent message
//   from going out twice.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TELEGRAM_STATE_FILE = "telegram-state.json";

export interface TelegramThreadCursor {
  /** Highest thread `seq` relayed or deliberately skipped. */
  relayedSeq: number;
  /** Last permanent refusal and last ambiguous send, retained across reconnects. */
  failedDelivery?: { seq: number; status: number };
  uncertainDeliverySeq?: number;
  /** Chunks of message `relayedSeq + 1` Telegram already accepted, with their message ids. */
  sentChunkIds?: string[] | undefined;
}

interface StateFileV1 {
  version: 1;
  /** The next `getUpdates` offset: the last handled `update_id` + 1, 0 before the first. */
  offset: number;
  bindingGeneration: number;
  credentialGeneration: number;
  threads: Record<string, TelegramThreadCursor>;
}

export class TelegramState {
  private data: StateFileV1;
  private readonly path: string;

  constructor(directory: string, generations: { binding: number; credential: number }) {
    this.path = join(directory, TELEGRAM_STATE_FILE);
    const loaded = this.read();
    const data: StateFileV1 = loaded ?? {
      version: 1,
      offset: 0,
      bindingGeneration: generations.binding,
      credentialGeneration: generations.credential,
      threads: {},
    };
    if (data.bindingGeneration !== generations.binding) data.threads = {};
    if (data.credentialGeneration !== generations.credential)
      for (const cursor of Object.values(data.threads)) cursor.sentChunkIds = undefined;
    data.bindingGeneration = generations.binding;
    data.credentialGeneration = generations.credential;
    this.data = data;
    this.save();
  }

  get offset(): number {
    return this.data.offset;
  }

  set offset(value: number) {
    if (value <= this.data.offset) return;
    this.data.offset = value;
    this.save();
  }

  threadIds(): string[] {
    return Object.keys(this.data.threads);
  }

  cursor(threadId: string): TelegramThreadCursor {
    const existing = this.data.threads[threadId];
    if (existing) return existing;
    const created: TelegramThreadCursor = { relayedSeq: 0 };
    this.data.threads[threadId] = created;
    this.save();
    return created;
  }

  /** Persist a cursor change made through `cursor()`. */
  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  private read(): StateFileV1 | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StateFileV1>;
      if (
        parsed.version !== 1 ||
        typeof parsed.offset !== "number" ||
        typeof parsed.bindingGeneration !== "number" ||
        typeof parsed.credentialGeneration !== "number" ||
        !parsed.threads ||
        typeof parsed.threads !== "object"
      )
        return undefined;
      return parsed as StateFileV1;
    } catch {
      // A torn or foreign file: start over. The worst case is Telegram redelivering unconfirmed
      // updates, which the Gateway deduplicates, and relays the send gate answers `already_sent`.
      return undefined;
    }
  }
}
