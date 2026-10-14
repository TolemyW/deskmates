// The adapter's only durable state (ADR-0017 decision 6): for each bound thread, who the sender is
// and the highest seq already relayed to them. Losing the file costs at most a few duplicate or
// skipped relays; the bindings themselves live in the Gateway.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BoundThread {
  threadId: string;
  /** The sender's `wa_id`, the recipient of every relay. */
  to: string;
  /** Highest thread `seq` relayed (or deliberately skipped) so far. */
  relayedSeq: number;
  /** Chunks of message `relayedSeq + 1` already delivered before a transient failure. */
  sentChunks?: number;
}

interface StateFile {
  version: 1;
  threads: BoundThread[];
}

export interface StateStore {
  all(): BoundThread[];
  get(threadId: string): BoundThread | undefined;
  byRecipient(to: string): BoundThread | undefined;
  put(entry: BoundThread): void;
}

export class MemoryStateStore implements StateStore {
  protected readonly entries = new Map<string, BoundThread>();

  all(): BoundThread[] {
    return [...this.entries.values()];
  }

  get(threadId: string): BoundThread | undefined {
    return this.entries.get(threadId);
  }

  byRecipient(to: string): BoundThread | undefined {
    for (const entry of this.entries.values()) if (entry.to === to) return entry;
    return undefined;
  }

  put(entry: BoundThread): void {
    this.entries.set(entry.threadId, { ...entry });
  }
}

/** JSON file, rewritten atomically on every change; small enough that this is fine. */
export class FileStateStore extends MemoryStateStore {
  constructor(private readonly path: string) {
    super();
    let raw: string | undefined;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      raw = undefined;
    }
    if (raw) {
      const parsed = JSON.parse(raw) as StateFile;
      if (parsed.version === 1 && Array.isArray(parsed.threads)) {
        for (const entry of parsed.threads) this.entries.set(entry.threadId, entry);
      }
    }
  }

  override put(entry: BoundThread): void {
    super.put(entry);
    const file: StateFile = { version: 1, threads: this.all() };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}
