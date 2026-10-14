// Operator-only linked-device material. Every mutation is one synced atomic snapshot.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  type SignalDataTypeMap,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

interface Snapshot {
  version: 1;
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
  outbound: string[];
}

export class WebAuthStore {
  readonly state: AuthenticationState;
  private snapshot: Snapshot;
  private closed = false;
  private readonly file: string;
  private readonly lock: string;

  constructor(readonly directory: string) {
    const absolute = resolve(directory);
    if (absolute === parse(absolute).root) throw new Error("Session directory cannot be a root");
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) {
      throw new Error("Session directory must be a real directory");
    }
    chmodSync(absolute, 0o700);
    this.file = join(absolute, "session.json");
    this.lock = join(absolute, "session.lock");
    this.acquireLock();
    try {
      const leftover = `${this.file}.next`;
      if (existsSync(leftover)) {
        if (!lstatSync(leftover).isFile() || lstatSync(leftover).isSymbolicLink()) {
          throw new Error("Session temporary file must be regular");
        }
        rmSync(leftover);
      }
      if (existsSync(this.file)) {
        if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) {
          throw new Error("Session file must be a regular file");
        }
        chmodSync(this.file, 0o600);
        this.snapshot = JSON.parse(readFileSync(this.file, "utf8"), BufferJSON.reviver) as Snapshot;
        if (
          this.snapshot.version !== 1 ||
          !this.snapshot.creds?.noiseKey ||
          !this.snapshot.keys ||
          !Array.isArray(this.snapshot.outbound)
        ) {
          throw new Error("Invalid session snapshot");
        }
      } else this.snapshot = this.fresh();
      this.state = {
        creds: this.snapshot.creds,
        keys: {
          get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
            const out: Record<string, SignalDataTypeMap[T]> = {};
            for (const id of ids) {
              let value = this.snapshot.keys[type]?.[id];
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              }
              if (value !== undefined) out[id] = value as SignalDataTypeMap[T];
            }
            return out;
          },
          set: async (data) => {
            this.assertOpen();
            for (const [type, entries] of Object.entries(data)) {
              const bucket = this.snapshot.keys[type] ?? {};
              for (const [id, value] of Object.entries(entries ?? {})) {
                if (value == null) delete bucket[id];
                else bucket[id] = value;
              }
              this.snapshot.keys[type] = bucket;
            }
            this.persist();
          },
        },
      };
      this.persist();
    } catch (error) {
      rmSync(this.lock);
      throw error;
    }
  }

  private fresh(): Snapshot {
    return { version: 1, creds: initAuthCreds(), keys: {}, outbound: [] };
  }

  private acquireLock(): void {
    // Exclusive creation; stale process locks may be reclaimed, live or unreadable ones never are.
    try {
      const fd = openSync(this.lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-owner recovery. Without this guard, two recovering
      // processes could delete each other's newly acquired lock.
      const guardPath = `${this.lock}.recovery`;
      const guard = openSync(guardPath, "wx", 0o600);
      try {
        if (!lstatSync(this.lock).isFile() || lstatSync(this.lock).isSymbolicLink()) throw error;
        const pid = Number(readFileSync(this.lock, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid session lock");
        try {
          process.kill(pid, 0);
        } catch (check) {
          if ((check as NodeJS.ErrnoException).code === "ESRCH") {
            rmSync(this.lock);
            const fd = openSync(this.lock, "wx", 0o600);
            try {
              writeFileSync(fd, String(process.pid));
            } finally {
              closeSync(fd);
            }
            return;
          }
          throw new Error("Session lock owner could not be checked");
        }
        throw new Error("Session directory is already in use");
      } finally {
        closeSync(guard);
        rmSync(guardPath);
      }
    }
  }

  saveCreds(update: Partial<AuthenticationCreds>): void {
    this.assertOpen();
    Object.assign(this.state.creds, update);
    this.persist();
  }

  rememberOutbound(id: string): void {
    this.assertOpen();
    if (!this.snapshot.outbound.includes(id)) {
      this.snapshot.outbound.push(id);
      this.snapshot.outbound = this.snapshot.outbound.slice(-2000);
      this.persist();
    }
  }

  isOutbound(id: string): boolean {
    return this.snapshot.outbound.includes(id);
  }

  reset(): void {
    this.assertOpen();
    this.snapshot = this.fresh();
    this.state.creds = this.snapshot.creds;
    this.persist();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    rmSync(this.lock);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session store is closed");
  }

  private persist(): void {
    this.assertOpen();
    const temp = `${this.file}.next`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.snapshot, BufferJSON.replacer));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    const dir = openSync(resolve(this.directory), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}
