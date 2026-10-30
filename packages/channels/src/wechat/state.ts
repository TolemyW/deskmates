// Operator-only private state. The Gateway owns the directory and removes it on disconnect.
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isChannelIdentityKey } from "@deskmates/contracts";
import { wechatOrigin } from "./api.js";

export interface WechatSession {
  account: string;
  token: string;
  origin: string;
}
export interface WechatCursor {
  seq: number;
  ids: string[];
}
interface Data {
  version: 1;
  binding: number;
  credential: number;
  session?: WechatSession | undefined;
  updateCursor: string;
  contexts: Record<string, string>;
  threads: Record<string, WechatCursor>;
}

export class WechatState {
  readonly path: string;
  data: Data;
  constructor(directory: string, binding: number, credential: number) {
    this.path = join(directory, "wechat-state.json");
    let loaded: Data | undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Data;
      if (
        parsed.version !== 1 ||
        !Number.isInteger(parsed.binding) ||
        !Number.isInteger(parsed.credential) ||
        typeof parsed.updateCursor !== "string" ||
        !parsed.contexts ||
        !parsed.threads ||
        typeof parsed.contexts !== "object" ||
        typeof parsed.threads !== "object" ||
        !Object.values(parsed.contexts).every((v) => typeof v === "string") ||
        !Object.values(parsed.threads).every(
          (v) =>
            v &&
            Number.isInteger(v.seq) &&
            v.seq >= 0 &&
            Array.isArray(v.ids) &&
            v.ids.every((id) => typeof id === "string"),
        )
      )
        throw new Error();
      if (parsed.session) {
        if (
          !isChannelIdentityKey(`wechat:ilink:${parsed.session.account}`, "wechat") ||
          typeof parsed.session.token !== "string" ||
          !parsed.session.token
        )
          throw new Error();
        wechatOrigin(parsed.session.origin);
      }
      loaded = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "WeChat connection state cannot be read. Restore its backup or disconnect and link again.",
        );
    }
    this.data = loaded ?? {
      version: 1,
      binding,
      credential,
      updateCursor: "",
      contexts: {},
      threads: {},
    };
    if (this.data.binding !== binding) {
      this.data.threads = {};
      this.data.contexts = {};
    }
    if (this.data.credential !== credential) {
      this.data.session = undefined;
      this.data.contexts = {};
      this.data.updateCursor = "";
      for (const cursor of Object.values(this.data.threads)) cursor.ids = [];
    }
    this.data.binding = binding;
    this.data.credential = credential;
    // Provider ids must never resolve inherited properties such as __proto__.
    this.data.contexts = Object.assign(Object.create(null), this.data.contexts);
    this.data.threads = Object.assign(Object.create(null), this.data.threads);
    this.save();
  }
  cursor(id: string): WechatCursor {
    const existing = this.data.threads[id];
    if (existing) return existing;
    const created: WechatCursor = { seq: 0, ids: [] };
    this.data.threads[id] = created;
    return created;
  }
  save(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}
