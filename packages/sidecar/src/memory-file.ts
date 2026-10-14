import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface MemoryView {
  body: string;
  version: string;
}
export type ManagedBotFile = "MEMORY.md" | "SOUL.md";

/** Manage only the two operator-governed bot context files. */
export function manageBotFile(root: string, input: unknown): MemoryView {
  const request = input as {
    botName?: unknown;
    fileName?: unknown;
    op?: unknown;
    body?: unknown;
    expectedVersion?: unknown;
  } | null;
  if (
    !request ||
    typeof request.botName !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(request.botName) ||
    (request.op !== "read" && request.op !== "write") ||
    (request.fileName !== undefined &&
      request.fileName !== "MEMORY.md" &&
      request.fileName !== "SOUL.md")
  )
    throw new Error("Invalid memory request");
  const fileName: ManagedBotFile = request.fileName === "SOUL.md" ? "SOUL.md" : "MEMORY.md";
  const home = join(resolve(root), request.botName);
  const file = join(home, fileName);
  const safeHome = (): void => {
    if (
      lstatSync(home).isSymbolicLink() ||
      realpathSync(home) !== join(realpathSync(root), request.botName as string)
    )
      throw new Error("Unsafe memory directory");
  };
  const read = (): MemoryView => {
    let body = "";
    if (existsSync(home)) {
      safeHome();
      if (
        existsSync(file) ||
        (() => {
          try {
            return lstatSync(file).isSymbolicLink();
          } catch {
            return false;
          }
        })()
      ) {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 65536)
            throw new Error("Memory must be a regular file of at most 65536 bytes");
          body = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      }
    }
    if (Buffer.byteLength(body) > 65536) throw new Error("Memory exceeds 65536 bytes");
    return { body, version: createHash("sha256").update(body).digest("hex") };
  };
  if (request.op === "read") return read();
  if (
    typeof request.body !== "string" ||
    Buffer.byteLength(request.body) > 65536 ||
    typeof request.expectedVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.expectedVersion)
  )
    throw new Error("Invalid memory content or version");
  mkdirSync(root, { recursive: true });
  if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
  safeHome();
  // The Gateway scheduler holds one workspace maintenance lease for operator writes.
  // Do not leave a persistent lock directory: a killed helper must not block future edits.
  // Bots and manually invoked helpers share these files by design (ADR-0004).
  const temporary = join(home, `.${fileName}-${randomUUID()}.tmp`);
  try {
    if (read().version !== request.expectedVersion)
      throw new Error("Memory changed; reload before editing");
    writeFileSync(temporary, request.body, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, file);
    return read();
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Backward-compatible entry point for the sidecar CLI and existing callers. */
export function manageMemory(root: string, input: unknown): MemoryView {
  return manageBotFile(root, input);
}
