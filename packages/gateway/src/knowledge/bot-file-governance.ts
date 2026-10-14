import type { BotId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

/** Apply database effects of a SOUL.md change after the file was durably replaced. */
export function commitSoulChange(db: GatewayDb, botId: BotId): number {
  return db.transaction(() => {
    db.prepare("UPDATE bots SET soul_version = soul_version + 1 WHERE id = ?").run(botId);
    db.prepare("DELETE FROM bot_sessions WHERE bot_id = ?").run(botId);
    return (
      db.prepare("SELECT soul_version FROM bots WHERE id = ?").get(botId) as {
        soul_version: number;
      }
    ).soul_version;
  })();
}
