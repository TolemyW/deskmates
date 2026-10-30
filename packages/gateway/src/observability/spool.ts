// The collector's local spool (ADR-0046 decision 2): JSONL files under the data directory that
// hold every row read from the ledger until the sink has committed it. It is also the received
// watermark: each append is one chunk of row lines followed by a marker line carrying the cursor
// after those rows, written with one `write` and made durable with `fsync` before the collector
// moves its cursor. After a crash, everything past the last complete marker is cut off, so the
// received cursor and the spooled rows cannot disagree.
//
// Files in the spool directory:
// - `<batch>.open.jsonl`: the batch being filled. Line 1 is the header (`h`: id, open time, the
//   cursor the batch starts from); then chunks of rows (`t`, `r`) each ended by a marker (`m`).
// - `<batch>.closed.jsonl`: a closed batch waiting for the sink; its last line (`c`) is the close
//   time. Closing is an append, an fsync and a rename, so a batch is either open or closed.
// - `committed.json`: the newest committed batch and the cursor after it (the committed
//   watermark), replaced atomically; a closed batch is deleted only after it is written.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_TABLES,
  type ObservabilityBatch,
  type ObservabilityRow,
  type ObservabilitySourceRange,
  type ObservabilityTable,
} from "@deskmates/contracts";
import { type CollectorCursor, cursorText, emptyCursor } from "./cursor.js";
import type { ObsRows } from "./ledger-reader.js";

/** Where a test may stop the collector as if the process were killed there. */
export type CrashPoint =
  | "spool.beforeWrite"
  | "spool.afterWrite"
  | "close.beforeRename"
  | "close.afterRename"
  | "commit.afterSink"
  | "commit.afterState";

export type Fault = (point: CrashPoint) => void;

export interface OpenBatch {
  batchId: string;
  openedAt: string;
  from: CollectorCursor;
  bytes: number;
}

export interface ClosedBatch {
  batchId: string;
  closedAt: string;
  bytes: number;
}

export interface CommittedState {
  batchId: string | null;
  committedAt: string | null;
  cursor: CollectorCursor;
}

export interface SpoolState {
  committed: CommittedState;
  open: OpenBatch | null;
  closed: ClosedBatch[];
  /** The cursor after the last spooled row: the received watermark. */
  received: CollectorCursor;
  /** Whether `committed.json` existed; false with no batches is a spool that never ran. */
  hadState: boolean;
}

const OPEN = ".open.jsonl";
const CLOSED = ".closed.jsonl";
const COMMITTED = "committed.json";
const ID_DIGITS = 12;

export function batchIdOf(seq: number): string {
  return String(seq).padStart(ID_DIGITS, "0");
}

function seqOf(batchId: string): number {
  return Number.parseInt(batchId, 10);
}

interface Line {
  h?: { batchId: string; openedAt: string; from: CollectorCursor };
  t?: ObservabilityTable;
  r?: ObservabilityRow;
  m?: { at: string; cursor: CollectorCursor };
  c?: { at: string };
}

/** Complete lines with the byte offset just after each. A torn last line is not returned. */
function linesOf(path: string): Array<{ line: Line; end: number }> {
  const buf = readFileSync(path);
  const out: Array<{ line: Line; end: number }> = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const text = buf.subarray(start, i).toString("utf8");
    start = i + 1;
    try {
      out.push({ line: JSON.parse(text) as Line, end: start });
    } catch {
      break; // A torn write cannot be followed by anything valid.
    }
  }
  return out;
}

function fsyncDir(dir: string): void {
  // Makes a create, rename or unlink in the directory durable. Some platforms refuse to open a
  // directory for fsync; there the rename is as durable as the platform makes it.
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function appendDurably(path: string, data: string): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class Spool {
  private state: SpoolState | undefined;
  private nextSeq = 1;

  constructor(
    readonly dir: string,
    private readonly fault: Fault = () => {},
  ) {}

  /** Read the directory back after a start or a crash; cuts a torn chunk off the open batch. */
  recover(): SpoolState {
    mkdirSync(this.dir, { recursive: true });
    const committedPath = join(this.dir, COMMITTED);
    const hadState = existsSync(committedPath);
    const committed: CommittedState = hadState
      ? (JSON.parse(readFileSync(committedPath, "utf8")) as CommittedState)
      : { batchId: null, committedAt: null, cursor: emptyCursor() };
    let maxSeq = committed.batchId ? seqOf(committed.batchId) : 0;
    let open: OpenBatch | null = null;
    let openCursor: CollectorCursor | undefined;
    const closed: Array<ClosedBatch & { cursor: CollectorCursor }> = [];
    for (const name of readdirSync(this.dir).sort()) {
      const path = join(this.dir, name);
      if (name.endsWith(CLOSED)) {
        const batchId = name.slice(0, -CLOSED.length);
        if (committed.batchId !== null && batchId <= committed.batchId) {
          // Committed, and `committed.json` says so; the crash came before the delete.
          unlinkSync(path);
          continue;
        }
        const lines = linesOf(path);
        const marker = [...lines].reverse().find((l) => l.line.m)?.line.m;
        const closeLine = lines.find((l) => l.line.c)?.line.c;
        if (!marker) {
          unlinkSync(path);
          continue;
        }
        maxSeq = Math.max(maxSeq, seqOf(batchId));
        closed.push({
          batchId,
          closedAt: closeLine?.at ?? statSync(path).mtime.toISOString(),
          bytes: statSync(path).size,
          cursor: marker.cursor,
        });
      } else if (name.endsWith(OPEN)) {
        const batchId = name.slice(0, -OPEN.length);
        const lines = linesOf(path);
        const header = lines[0]?.line.h;
        let end = 0;
        for (const l of lines) if (l.line.m) end = l.end;
        if (!header || end === 0) {
          unlinkSync(path);
          continue;
        }
        if (statSync(path).size !== end) {
          truncateSync(path, end);
          const fd = openSync(path, "r+");
          fsyncSync(fd);
          closeSync(fd);
        }
        maxSeq = Math.max(maxSeq, seqOf(batchId));
        open = { batchId, openedAt: header.openedAt, from: header.from, bytes: end };
        openCursor = [...lines].reverse().find((l) => l.line.m && l.end <= end)?.line.m?.cursor;
      } else if (name.endsWith(".tmp")) {
        unlinkSync(path);
      }
    }
    fsyncDir(this.dir);
    this.nextSeq = maxSeq + 1;
    const lastClosed = closed[closed.length - 1];
    const received = openCursor ?? lastClosed?.cursor ?? committed.cursor;
    this.state = {
      committed,
      open,
      closed: closed.map(({ cursor: _cursor, ...batch }) => batch),
      received,
      hadState,
    };
    return this.state;
  }

  private get s(): SpoolState {
    if (!this.state) throw new Error("spool not recovered");
    return this.state;
  }

  get snapshot(): Readonly<SpoolState> {
    return this.s;
  }

  /** Append one chunk of rows with the cursor after them; opens a batch when none is open. */
  append(rows: ObsRows, cursor: CollectorCursor, now: Date): void {
    const lines: string[] = [];
    for (const table of OBSERVABILITY_TABLES)
      for (const r of rows[table] ?? []) lines.push(JSON.stringify({ t: table, r }));
    if (lines.length === 0) return;
    lines.push(JSON.stringify({ m: { at: now.toISOString(), cursor } }));
    let open = this.s.open;
    let chunk = `${lines.join("\n")}\n`;
    const fresh = open === null;
    if (open === null) {
      open = {
        batchId: batchIdOf(this.nextSeq++),
        openedAt: now.toISOString(),
        from: this.s.received,
        bytes: 0,
      };
      chunk = `${JSON.stringify({ h: { batchId: open.batchId, openedAt: open.openedAt, from: open.from } })}\n${chunk}`;
    }
    this.fault("spool.beforeWrite");
    const path = join(this.dir, `${open.batchId}${OPEN}`);
    appendDurably(path, chunk);
    if (fresh) fsyncDir(this.dir);
    this.fault("spool.afterWrite");
    open.bytes += Buffer.byteLength(chunk, "utf8");
    this.s.open = open;
    this.s.received = cursor;
  }

  /** Close the open batch: it is no longer appended to and waits for the sink. */
  close(now: Date): void {
    const open = this.s.open;
    if (!open) return;
    const from = join(this.dir, `${open.batchId}${OPEN}`);
    const closedAt = now.toISOString();
    const line = `${JSON.stringify({ c: { at: closedAt } })}\n`;
    this.fault("close.beforeRename");
    appendDurably(from, line);
    renameSync(from, join(this.dir, `${open.batchId}${CLOSED}`));
    fsyncDir(this.dir);
    this.fault("close.afterRename");
    this.s.closed.push({
      batchId: open.batchId,
      closedAt,
      bytes: open.bytes + Buffer.byteLength(line, "utf8"),
    });
    this.s.open = null;
  }

  /** A closed batch as the sink receives it, with the cursor after its last row. */
  load(batchId: string): { batch: ObservabilityBatch; cursor: CollectorCursor } {
    const lines = linesOf(join(this.dir, `${batchId}${CLOSED}`));
    const header = lines[0]?.line.h;
    if (!header) throw new Error(`spool batch ${batchId} has no header`);
    const tables: Partial<Record<ObservabilityTable, ObservabilityRow[]>> = {};
    let cursor: CollectorCursor | undefined;
    let closedAt = "";
    for (const { line } of lines) {
      if (line.t && line.r) {
        const list = tables[line.t] ?? [];
        list.push(line.r);
        tables[line.t] = list;
      } else if (line.m) cursor = line.m.cursor;
      else if (line.c) closedAt = line.c.at;
    }
    if (!cursor) throw new Error(`spool batch ${batchId} has no marker`);
    const sources: Partial<Record<ObservabilityTable, ObservabilitySourceRange>> = {};
    for (const table of Object.keys(tables) as ObservabilityTable[])
      sources[table] = {
        first: cursorText(header.from, table),
        last: cursorText(cursor, table) ?? "",
      };
    return {
      batch: {
        contractVersion: OBSERVABILITY_CONTRACT_VERSION,
        batchId,
        openedAt: header.openedAt,
        closedAt,
        tables,
        sources,
      },
      cursor,
    };
  }

  /** Record a fully committed batch as the committed watermark, then drop its file. */
  committed(batchId: string, cursor: CollectorCursor, now: Date): void {
    const state: CommittedState = { batchId, committedAt: now.toISOString(), cursor };
    const path = join(this.dir, COMMITTED);
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDir(this.dir);
    this.s.committed = state;
    this.s.hadState = true;
    this.fault("commit.afterState");
    unlinkSync(join(this.dir, `${batchId}${CLOSED}`));
    fsyncDir(this.dir);
    this.s.closed = this.s.closed.filter((b) => b.batchId !== batchId);
  }

  /** Bytes in the spool directory. */
  bytes(): number {
    let total = 0;
    for (const name of readdirSync(this.dir)) {
      try {
        total += statSync(join(this.dir, name)).size;
      } catch {
        // Deleted between the listing and the stat.
      }
    }
    return total;
  }
}
