// The PreCompact hook (M3 context plan, Phase 1): before the SDK compacts a conversation, copy the
// transcript it is about to summarise to `<bot home>/.claude/compact-archive/`, so what the bot
// saw before the boundary can still be read after it. Compaction otherwise leaves nothing behind.
//
// Fail open: a new SDK transcript may not be on disk yet. Wait at most 1.55 seconds for
// a missing/empty transcript or the latest observed tool result; other read errors become a
// `warn` log in the ledger and nothing else. Registered next to the PreToolUse hook in
// `run-once.ts`; like every file in the workspace, the archive is readable by every bot there.
//
// Memory flush (ADR-0011 decision 8): the hook asks the model nothing. It ledgers what the sidecar
// already holds at the boundary: the run's taint so far and any learned items in the latest
// assistant text that already carries a summary block, stamped with trust. The run's final
// summary still reports everything it learned; the flush only makes the pre-compaction state
// auditable after compaction has replaced the history it came from.

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { SidecarFs } from "../deps.js";
import type { EventSink } from "../ledger.js";

export interface PreCompactContext {
  botHomeDir: string;
  fs: SidecarFs;
  sink: EventSink;
  now: () => Date;
  /** What the sidecar knows at the boundary; ledgered as `pre_compact` / `memory_flush`. */
  memoryFlush?: () => Record<string, unknown>;
  /** Last top-level SDK tool-result message observed; its persisted JSON record must be present. */
  latestToolResultUuid?: () => string | undefined;
}

// SDK 0.3.278 can call PreCompact before its new-session transcript write completes.
// Bound this availability wait; permission and other I/O failures must not be retried.
const TRANSCRIPT_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

async function readTranscript(
  fs: SidecarFs,
  path: string,
  latestToolResultUuid?: () => string | undefined,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await fs.readFile(path);
      const uuid = latestToolResultUuid?.();
      const persisted =
        uuid === undefined ||
        text.split("\n").some((line) => {
          try {
            const record = JSON.parse(line) as { type?: string; uuid?: string };
            return record.type === "user" && record.uuid === uuid;
          } catch {
            return false;
          }
        });
      if (text.length > 0 && persisted) return text;
      throw Object.assign(new Error("SDK transcript has not persisted the latest tool result"), {
        code: "ENOENT",
      });
    } catch (error) {
      const delay = TRANSCRIPT_RETRY_DELAYS_MS[attempt];
      const missing =
        error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
      if (!missing || delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** `<home>/.claude/compact-archive/<sessionId>-<timestamp>.jsonl`, safe as one path segment. */
export function compactArchivePath(botHomeDir: string, sessionId: string, at: Date): string {
  const session = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${botHomeDir}/.claude/compact-archive/${session}-${stamp}.jsonl`;
}

export function createPreCompactHook(ctx: PreCompactContext): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreCompact") return { continue: true };
    const archivePath = compactArchivePath(ctx.botHomeDir, input.session_id, ctx.now());
    try {
      const text = await readTranscript(
        ctx.fs,
        input.transcript_path,
        input.agent_id === undefined ? ctx.latestToolResultUuid : undefined,
      );
      // `appendFile` creates the directory; the name is unique per session and millisecond.
      await ctx.fs.appendFile(archivePath, text);
      ctx.sink.emit("log", {
        source: "pre_compact",
        op: "archived",
        trigger: input.trigger,
        archivePath,
        chars: text.length,
      });
    } catch (err) {
      ctx.sink.emit("log", {
        source: "pre_compact",
        level: "warn",
        op: "archive_failed",
        trigger: input.trigger,
        error: String(err),
      });
    }
    if (ctx.memoryFlush) {
      try {
        ctx.sink.emit("log", {
          source: "pre_compact",
          op: "memory_flush",
          trigger: input.trigger,
          ...ctx.memoryFlush(),
        });
      } catch (err) {
        ctx.sink.emit("log", {
          source: "pre_compact",
          level: "warn",
          op: "memory_flush_failed",
          error: String(err),
        });
      }
    }
    return { continue: true };
  };
}
