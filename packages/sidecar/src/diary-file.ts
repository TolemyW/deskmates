// `deskmates-sidecar diary`: the operator's read-only view of a bot's diary with single-line
// deletes (ADR-0043 decision 4). Only `<root>/<bot>/memory/YYYY-MM-DD.md` is ever opened; a
// symlinked home, memory directory or day file is refused. A delete names the line's index, its
// exact text and the file's sha256, so a line the bot appended since the read is never lost: any
// change in between refuses the delete and the operator reloads.

import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DIARY_DAY_MAX_BYTES, DIARY_DAY_PATTERN } from "@deskmates/contracts";

const BOT_NAME = /^[A-Za-z0-9_-]+$/;
/** The newest days a list answer carries. */
export const DIARY_LIST_MAX = 120;

export interface DiaryDayView {
  day: string;
  lines: string[];
  version: string;
}

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A file ending in a newline has no trailing empty line; the empty file has no lines. */
function linesOf(body: string): string[] {
  if (body === "") return [];
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function manageDiary(root: string, input: unknown): unknown {
  const request = input as {
    op?: unknown;
    botName?: unknown;
    day?: unknown;
    line?: unknown;
    text?: unknown;
    version?: unknown;
  } | null;
  if (
    !request ||
    typeof request.botName !== "string" ||
    !BOT_NAME.test(request.botName) ||
    (request.op !== "list" && request.op !== "read" && request.op !== "delete-line")
  )
    throw new Error("Invalid diary request");
  const home = join(resolve(root), request.botName);
  const dir = join(home, "memory");
  const safeDir = (): boolean => {
    try {
      if (lstatSync(home).isSymbolicLink() || lstatSync(dir).isSymbolicLink())
        throw new Error("Unsafe diary directory");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (realpathSync(dir) !== join(realpathSync(root), request.botName as string, "memory"))
      throw new Error("Unsafe diary directory");
    return true;
  };
  if (request.op === "list") {
    if (!safeDir()) return { days: [] };
    const days = readdirSync(dir)
      .filter((name) => name.endsWith(".md") && DIARY_DAY_PATTERN.test(name.slice(0, -3)))
      .flatMap((name) => {
        const stat = lstatSync(join(dir, name));
        return stat.isFile() ? [{ day: name.slice(0, -3), bytes: stat.size }] : [];
      })
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, DIARY_LIST_MAX);
    return { days };
  }
  if (typeof request.day !== "string" || !DIARY_DAY_PATTERN.test(request.day))
    throw new Error("Invalid diary day");
  const day = request.day;
  const file = join(dir, `${day}.md`);
  const read = (): DiaryDayView & { mode: number } => {
    if (!safeDir()) return { day, lines: [], version: digest(""), mode: 0o644 };
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { day, lines: [], version: digest(""), mode: 0o644 };
      throw new Error("The diary day must be a regular file");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > DIARY_DAY_MAX_BYTES)
        throw new Error(
          `A diary day must be a regular file of at most ${DIARY_DAY_MAX_BYTES} bytes`,
        );
      const body = readFileSync(fd, "utf8");
      return { day, lines: linesOf(body), version: digest(body), mode: stat.mode & 0o777 };
    } finally {
      closeSync(fd);
    }
  };
  const view = (): DiaryDayView => {
    const { mode: _mode, ...rest } = read();
    return rest;
  };
  if (request.op === "read") return view();
  const { line, text, version } = request;
  if (
    typeof line !== "number" ||
    !Number.isSafeInteger(line) ||
    line < 0 ||
    typeof text !== "string" ||
    typeof version !== "string"
  )
    throw new Error("Invalid diary delete");
  const current = read();
  if (current.version !== version || current.lines[line] !== text)
    throw new Error("The diary changed since it was read; reload before deleting");
  const remaining = current.lines.filter((_, index) => index !== line);
  const body = remaining.length === 0 ? "" : `${remaining.join("\n")}\n`;
  const temporary = join(dir, `.${day}.md-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: current.mode, flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return view();
}
