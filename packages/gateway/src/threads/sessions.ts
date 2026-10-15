// Per-(bot, thread) SDK session ids (design v0.3 §3.2). The transcript is not here; only the
// handle the sidecar passes to `resume` so the bot continues its private view of the thread.
// A session belongs to the runtime that wrote it (ADR-0042 decision 6): a bot moved to the other
// runtime starts a new session instead of resuming a transcript it cannot read.

import type { AgentRuntime, BotId, ThreadId } from "@deskmates/contracts";
import { DEFAULT_AGENT_RUNTIME } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export class SessionStore {
  constructor(private readonly db: GatewayDb) {}

  /** The stored session for (bot, thread) when `runtime` wrote it; undefined otherwise. */
  get(
    botId: BotId,
    threadId: ThreadId,
    runtime: AgentRuntime = DEFAULT_AGENT_RUNTIME,
  ): string | undefined {
    const row = this.db
      .prepare(
        "SELECT sdk_session_id, runtime FROM bot_sessions WHERE bot_id = ? AND thread_id = ?",
      )
      .get(botId, threadId) as { sdk_session_id: string; runtime: string } | undefined;
    return row !== undefined && row.runtime === runtime ? row.sdk_session_id : undefined;
  }

  /**
   * Record the session a run left. `tainted` marks that untrusted content entered it (ADR-0011
   * decision 3); taint only accumulates while the session id stays the same, and a new session
   * starts clean.
   */
  set(
    botId: BotId,
    threadId: ThreadId,
    sdkSessionId: string,
    tainted = false,
    runtime: AgentRuntime = DEFAULT_AGENT_RUNTIME,
  ): void {
    this.db
      .prepare(
        `INSERT INTO bot_sessions (bot_id, thread_id, sdk_session_id, updated_at, tainted, runtime)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, thread_id) DO UPDATE SET
           tainted = CASE WHEN bot_sessions.sdk_session_id = excluded.sdk_session_id
                          THEN MAX(bot_sessions.tainted, excluded.tainted)
                          ELSE excluded.tainted END,
           sdk_session_id = excluded.sdk_session_id,
           runtime = excluded.runtime,
           updated_at = excluded.updated_at`,
      )
      .run(botId, threadId, sdkSessionId, nowIso(), tainted ? 1 : 0, runtime);
  }

  /** Whether the stored session for (bot, thread) already carries untrusted content. */
  tainted(botId: BotId, threadId: ThreadId): boolean {
    const row = this.db
      .prepare("SELECT tainted FROM bot_sessions WHERE bot_id = ? AND thread_id = ?")
      .get(botId, threadId) as { tainted: number } | undefined;
    return row?.tainted === 1;
  }
}
