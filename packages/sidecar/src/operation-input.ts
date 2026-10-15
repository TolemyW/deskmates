// Inputs of the look/OCR and speech tools (ADR-0040 decisions 4 to 6): which workspace files the
// tools read, how a PDF is split into text-layer pages and rendered pages, and the duration of a
// WAV file. Everything is checked here before any bytes leave the container.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A refusal the tool returns to the model as text; nothing was sent anywhere. */
export class OperationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationInputError";
  }
}

/** The roots a tool may read under, inside the container. `/profile` (the browser) is not one. */
export const OPERATION_ROOTS = ["/work", "/home", "/tmp"] as const;

/** The PDF commands of `poppler-utils`, injected so tests need no binary. */
export interface PdfTools {
  pageCount(path: string): Promise<number>;
  /** The page's text layer (`pdftotext -layout`), empty when it has none. */
  pageText(path: string, page: number): Promise<string>;
  /** The page rendered as PNG bytes (`pdftoppm -png -r 150`). */
  renderPage(path: string, page: number): Promise<Buffer>;
}

export interface OperationFiles {
  /** Resolve, check and read one regular file of at most `maxBytes`. */
  read(path: string, maxBytes: number): Promise<{ path: string; bytes: Buffer }>;
  pdf: PdfTools;
}

const outside = (path: string) =>
  new OperationInputError(
    `${path} is not a regular file under /work, /home or /tmp of this workspace`,
  );

/**
 * The real reader. `root` stands for the container's `/`; tests pass a temporary directory. The
 * path must name a file under an allowed root both as written and after links are resolved.
 */
export function createOperationFiles(opts: { root?: string; pdf?: PdfTools } = {}): OperationFiles {
  const root = opts.root ?? "/";
  const roots = async () => {
    const real: string[] = [];
    for (const logical of OPERATION_ROOTS) {
      try {
        real.push(await realpath(join(root, logical)));
      } catch {
        // A root that does not exist admits nothing.
      }
    }
    return real;
  };
  return {
    async read(path, maxBytes) {
      if (!path.startsWith("/") || path.split("/").includes(".."))
        throw new OperationInputError(`${path} must be an absolute path without ..`);
      if (!OPERATION_ROOTS.some((r) => path.startsWith(`${r}/`))) throw outside(path);
      let resolved: string;
      try {
        resolved = await realpath(join(root, path));
      } catch {
        throw new OperationInputError(`${path} does not exist`);
      }
      if (!(await roots()).some((dir) => resolved.startsWith(`${dir}${sep}`))) throw outside(path);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          resolved,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch {
        throw outside(path);
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw outside(path);
        if (stat.size > maxBytes)
          throw new OperationInputError(
            `${path} is ${stat.size} bytes; the limit is ${maxBytes} bytes`,
          );
        const bytes = await handle.readFile();
        if (bytes.length > maxBytes)
          throw new OperationInputError(`${path} grew past ${maxBytes} bytes while reading`);
        return { path: resolved, bytes };
      } finally {
        await handle.close();
      }
    },
    pdf: opts.pdf ?? popplerTools,
  };
}

/** Output bound of one poppler command: a page's text or image, never a whole book. */
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

/** `poppler-utils` from the workspace base image, run without a shell. */
export const popplerTools: PdfTools = {
  async pageCount(path) {
    const { stdout } = await run("pdfinfo", [path], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) throw new OperationInputError("pdfinfo reported no page count");
    return Number(match[1]);
  },
  async pageText(path, page) {
    const { stdout } = await run(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), path, "-"],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER },
    );
    return stdout;
  },
  async renderPage(path, page) {
    const dir = await mkdtemp(join(tmpdir(), "deskmates-page-"));
    try {
      const prefix = join(dir, "page");
      await run(
        "pdftoppm",
        ["-png", "-r", "150", "-f", String(page), "-l", String(page), "-singlefile", path, prefix],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER },
      );
      return await readFile(`${prefix}.png`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/**
 * The pages named by `spec` ("3", "1-3", "2,5,7-8"), in order and without repeats, or the first
 * `defaultPages` when it is absent. Pages past the end are refused, as are more than `max`.
 */
export function parsePages(
  spec: string | undefined,
  pageCount: number,
  max: number,
  defaultPages: number,
): number[] {
  if (pageCount < 1) throw new OperationInputError("the PDF has no pages");
  if (spec === undefined || spec.trim() === "") {
    return Array.from({ length: Math.min(pageCount, defaultPages) }, (_, i) => i + 1);
  }
  const pages: number[] = [];
  for (const part of spec.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new OperationInputError(`pages "${spec}" is not like "1-3" or "2,5"`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < from)
      throw new OperationInputError(`pages "${spec}" is not like "1-3" or "2,5"`);
    if (to > pageCount)
      throw new OperationInputError(`the PDF has ${pageCount} pages; page ${to} does not exist`);
    if (to - from + 1 > max)
      throw new OperationInputError(`at most ${max} pages per call; ask for the rest separately`);
    for (let p = from; p <= to; p++) if (!pages.includes(p)) pages.push(p);
    if (pages.length > max)
      throw new OperationInputError(`at most ${max} pages per call; ask for the rest separately`);
  }
  return pages;
}

/** Non-space characters of a page's text layer. */
export function textLayerChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * Seconds of a PCM WAV file from its `fmt ` and `data` chunks, or undefined when the header is
 * not one this reads. Compressed formats are not decoded (decision 6).
 */
export function wavDurationSeconds(bytes: Buffer): number | undefined {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF") return undefined;
  if (bytes.toString("latin1", 8, 12) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 16 <= bytes.length) byteRate = bytes.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!byteRate) return undefined;
      // A streaming writer may leave the size at its maximum; the bytes present bound it.
      const dataBytes = Math.min(size, bytes.length - offset - 8);
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}
