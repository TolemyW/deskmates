// Per-(bot, thread) SDK session ids (design v0.3 §3.2). The transcript is not here; only the
// handle the sidecar passes to `resume` so the bot continues its private view of the thread.

import type { BotId, ThreadId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";

export class SessionStore {
  constructor(private readonly db: GatewayDb) {}

  get(botId: BotId, threadId: ThreadId): string | undefined {
    const row = this.db
      .prepare("SELECT sdk_session_id FROM bot_sessions WHERE bot_id = ? AND thread_id = ?")
      .get(botId, threadId) as { sdk_session_id: string } | undefined;
    return row?.sdk_session_id;
  }

  /**
   * Record the session a run left. `tainted` marks that untrusted content entered it (ADR-0011
   * decision 3); taint only accumulates while the session id stays the same, and a new session
   * starts clean.
   */
  set(botId: BotId, threadId: ThreadId, sdkSessionId: string, tainted = false): void {
    this.db
      .prepare(
        `INSERT INTO bot_sessions (bot_id, thread_id, sdk_session_id, updated_at, tainted)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, thread_id) DO UPDATE SET
           tainted = CASE WHEN bot_sessions.sdk_session_id = excluded.sdk_session_id
                          THEN MAX(bot_sessions.tainted, excluded.tainted)
                          ELSE excluded.tainted END,
           sdk_session_id = excluded.sdk_session_id,
           updated_at = excluded.updated_at`,
      )
      .run(botId, threadId, sdkSessionId, nowIso(), tainted ? 1 : 0);
  }

  /** Whether the stored session for (bot, thread) already carries untrusted content. */
  tainted(botId: BotId, threadId: ThreadId): boolean {
    const row = this.db
      .prepare("SELECT tainted FROM bot_sessions WHERE bot_id = ? AND thread_id = ?")
      .get(botId, threadId) as { tainted: number } | undefined;
    return row?.tainted === 1;
  }
}
