// A connection's private state (ADR-0047 decision 14): per-thread relay cursors with the chunks of
// a half-sent message, and the event ids recently handled. One JSON file in the connection's state
// directory (0700, the file 0600), rewritten atomically. It never holds a token. The cursors
// belong to one binding generation and one credential generation; opening with another discards
// them, so a rebind or relink never relays from the old ones (decision 8). Losing the file costs
// at most a re-check of every message through the send gate, which refuses what was already sent.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SlackThreadCursor {
  /** Highest thread seq relayed or deliberately skipped. */
  relayedSeq: number;
  /** Provider ids of the chunks of message `relayedSeq + 1` already sent before a failure. */
  sentChunkIds?: string[];
}

interface StateFile {
  version: 1;
  bindingGeneration: number;
  credentialGeneration: number;
  threads: Record<string, SlackThreadCursor>;
  /** Recently handled Slack event ids, oldest first. */
  events: string[];
}

/** How many handled event ids are remembered; Slack retries an event for minutes, not days. */
export const SLACK_EVENT_MEMORY = 1000;

export const SLACK_STATE_FILE = "slack-state.json";

export class SlackStateStore {
  private state: StateFile;
  private readonly eventSet: Set<string>;
  private readonly path: string | undefined;

  /** `directory` undefined keeps the state in memory only (tests of pure logic). */
  constructor(
    private readonly directory: string | undefined,
    generations: { bindingGeneration: number; credentialGeneration: number },
  ) {
    this.path = directory ? join(directory, SLACK_STATE_FILE) : undefined;
    const fresh: StateFile = { version: 1, ...generations, threads: {}, events: [] };
    let loaded: StateFile | undefined;
    if (this.path) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StateFile>;
        if (parsed.version === 1 && parsed.threads && Array.isArray(parsed.events))
          loaded = parsed as StateFile;
      } catch {
        loaded = undefined;
      }
    }
    if (
      loaded &&
      loaded.bindingGeneration === generations.bindingGeneration &&
      loaded.credentialGeneration === generations.credentialGeneration
    ) {
      this.state = loaded;
    } else {
      // Another binding or credential generation: cursors do not carry over. Event ids do, so a
      // Slack retry that straddles a relink is still recognised.
      this.state = { ...fresh, events: loaded?.events ?? [] };
    }
    this.eventSet = new Set(this.state.events);
    this.write();
  }

  threads(): string[] {
    return Object.keys(this.state.threads);
  }

  cursor(threadId: string): SlackThreadCursor | undefined {
    return this.state.threads[threadId];
  }

  putCursor(threadId: string, cursor: SlackThreadCursor): void {
    this.state.threads[threadId] = cursor;
    this.write();
  }

  dropThread(threadId: string): void {
    delete this.state.threads[threadId];
    this.write();
  }

  hasEvent(eventId: string): boolean {
    return this.eventSet.has(eventId);
  }

  addEvent(eventId: string): void {
    if (this.eventSet.has(eventId)) return;
    this.eventSet.add(eventId);
    this.state.events.push(eventId);
    while (this.state.events.length > SLACK_EVENT_MEMORY) {
      const oldest = this.state.events.shift();
      if (oldest !== undefined) this.eventSet.delete(oldest);
    }
    this.write();
  }

  /** Disconnect: the Gateway removes the directory too; this keeps a reused directory clean. */
  remove(): void {
    if (this.path) rmSync(this.path, { force: true });
  }

  private write(): void {
    if (!this.path || !this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}
