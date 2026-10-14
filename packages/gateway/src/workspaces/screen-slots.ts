import { type BotId, DeskmatesError, type WorkspaceId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export class ScreenSlotStore {
  constructor(private readonly db: GatewayDb) {}
  get(botId: BotId): number | undefined {
    return (
      this.db.prepare("SELECT slot FROM bot_screen_slots WHERE bot_id = ?").get(botId) as
        | { slot: number }
        | undefined
    )?.slot;
  }
  ensure(botId: BotId, workspaceId: WorkspaceId): number {
    return this.db.transaction(() => {
      const current = this.get(botId);
      if (current !== undefined) return current;
      const bot = this.db.prepare("SELECT workspace_id FROM bots WHERE id = ?").get(botId) as
        | { workspace_id: string }
        | undefined;
      if (bot?.workspace_id !== workspaceId)
        throw new DeskmatesError("validation", "bot does not belong to workspace");
      const used = new Set(
        (
          this.db
            .prepare("SELECT slot FROM bot_screen_slots WHERE workspace_id = ?")
            .all(workspaceId) as { slot: number }[]
        ).map((row) => row.slot),
      );
      const slot = Array.from({ length: 6 }, (_, i) => i).find((i) => !used.has(i));
      if (slot === undefined)
        throw new DeskmatesError(
          "queue_full",
          "This workspace has six allocated desktop screens. Use another workspace for additional screens.",
        );
      this.db
        .prepare("INSERT INTO bot_screen_slots (bot_id, workspace_id, slot) VALUES (?, ?, ?)")
        .run(botId, workspaceId, slot);
      return slot;
    })();
  }
}
