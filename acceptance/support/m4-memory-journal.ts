import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { memoryDigest } from "./m4-memory-budget.js";
import type { MemoryJournal, MemoryJournalAck, MemoryJournalEvent } from "./m4-memory-driver.js";

/** Exclusive evaluator-host journal. Existing directories (including interrupted campaigns)
 * are never reopened. A failed write/sync poisons this writer; manual reconciliation is
 * required even when the caller did not receive an acknowledgement. No secrets belong here. */
export class MemoryFileJournal implements MemoryJournal {
  private file: FileHandle | null = null;
  private claimed = false;
  private poisoned = false;
  private sequence = 0;
  private previousSha256: string | null = null;
  private planSha256: string | null = null;

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error("journal directory must be absolute and fresh");
  }

  async claim(event: MemoryJournalEvent): Promise<MemoryJournalAck> {
    if (this.claimed || this.poisoned) throw new Error("campaign journal already claimed");
    this.claimed = true;
    try {
      if (event.kind !== "frozen-plan") throw new Error("first event must freeze the plan");
      // Deliberately no recursive or exist-ok option: the parent must already exist.
      await mkdir(this.directory, { mode: 0o700 });
      this.file = await open(join(this.directory, "events.jsonl"), "ax", 0o600);
      const ack = await this.append(event);
      for (const path of [this.directory, dirname(this.directory)]) {
        const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return ack;
    } catch (error) {
      this.poisoned = true;
      await this.close();
      throw error;
    }
  }

  async append(event: MemoryJournalEvent): Promise<MemoryJournalAck> {
    if (!this.file || this.poisoned) throw new Error("journal unavailable; no automatic recovery");
    try {
      const { sha256, ...body } = event;
      if (
        event.sequence !== this.sequence + 1 ||
        event.previousSha256 !== this.previousSha256 ||
        (this.planSha256 !== null && event.driverPlanSha256 !== this.planSha256) ||
        sha256 !== memoryDigest(body)
      )
        throw new Error("journal sequence/hash/plan mismatch");
      await this.file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await this.file.sync();
      this.sequence = event.sequence;
      this.previousSha256 = sha256;
      this.planSha256 = event.driverPlanSha256;
      return { sequence: event.sequence, sha256, durable: true };
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    const file = this.file;
    this.file = null;
    if (file) await file.close();
  }
}
