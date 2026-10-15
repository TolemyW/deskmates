// The OpenAI runtime's transcript (ADR-0042 decision 6): one JSON file per session in the bot's
// home directory, holding the conversation items the Agents SDK replays on the next run and the
// cumulative token totals the Gateway's per-session accounting expects (`ledger/usage.ts`). A
// parked run's serialised `RunState` sits beside it until the run resumes or ends.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInputItem, Session } from "@openai/agents";
import type { ModelUsageTotals } from "./sdk-messages.js";

interface SessionFile {
  version: 1;
  id: string;
  items: AgentInputItem[];
  /** Per model id; cumulative over every run of the session. */
  usage: Record<string, ModelUsageTotals>;
}

const SESSION_SUBDIR = ".deskmates/openai-sessions";

/** Where a bot's OpenAI sessions live. */
export function sessionDirOf(botHomeDir: string): string {
  return join(botHomeDir, SESSION_SUBDIR);
}

export class FileSession implements Session {
  private constructor(
    private readonly dir: string,
    private readonly file: SessionFile,
  ) {}

  /** Opens an existing session or starts an empty one under `dir`. */
  static async open(dir: string, id: string): Promise<FileSession> {
    await mkdir(dir, { recursive: true });
    let file: SessionFile = { version: 1, id, items: [], usage: {} };
    try {
      const parsed = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as SessionFile;
      if (parsed.version === 1 && parsed.id === id && Array.isArray(parsed.items)) {
        file = { ...parsed, usage: parsed.usage ?? {} };
      }
    } catch {
      /* No file yet, or unreadable: a fresh transcript. */
    }
    return new FileSession(dir, file);
  }

  get id(): string {
    return this.file.id;
  }

  /** Cumulative totals per model over the session, as last saved. */
  get totals(): Readonly<Record<string, ModelUsageTotals>> {
    return this.file.usage;
  }

  async getSessionId(): Promise<string> {
    return this.file.id;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = this.file.items;
    return limit === undefined ? [...items] : items.slice(Math.max(0, items.length - limit));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.file.items.push(...items);
    await this.save();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.file.items.pop();
    await this.save();
    return item;
  }

  async clearSession(): Promise<void> {
    this.file.items = [];
    await this.save();
  }

  /** Adds one run's share to the cumulative totals and saves. */
  async addUsage(delta: Readonly<Record<string, ModelUsageTotals>>): Promise<void> {
    for (const [model, d] of Object.entries(delta)) {
      const prior = this.file.usage[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
      };
      this.file.usage[model] = {
        inputTokens: prior.inputTokens + d.inputTokens,
        outputTokens: prior.outputTokens + d.outputTokens,
        cacheReadInputTokens: prior.cacheReadInputTokens + d.cacheReadInputTokens,
      };
    }
    await this.save();
  }

  private get statePath(): string {
    return join(this.dir, `${this.file.id}.state.json`);
  }

  /** The serialised `RunState` of a parked run, if this session has one. */
  async loadState(): Promise<string | undefined> {
    try {
      return await readFile(this.statePath, "utf8");
    } catch {
      return undefined;
    }
  }

  async saveState(serialized: string): Promise<void> {
    await writeAtomically(this.statePath, serialized);
  }

  async clearState(): Promise<void> {
    await rm(this.statePath, { force: true });
  }

  private async save(): Promise<void> {
    await writeAtomically(join(this.dir, `${this.file.id}.json`), JSON.stringify(this.file));
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}
