// The shared computer: the workspace browser hold, per-bot screens and screen-proxy tickets
// (ADR-0004, ADR-0008, ADR-0022 amendment 1 C7).

import type {
  BotId,
  BotScreen,
  BrowserLock,
  ScreenAccess,
  WorkspaceId,
} from "@deskmates/contracts";
import type { WorkspaceView } from "../../api/types.js";
import { type HttpTransport, stripUndefined } from "../../platform/http-transport.js";

export interface ComputerApi {
  closeScreenAccess(id: string): Promise<void>;
  getBotScreen(id: BotId): Promise<BotScreen>;
  /** One workspace with its bots, the human browser hold, and whether its screen is up. */
  getWorkspace(id: WorkspaceId): Promise<WorkspaceView>;
  handBack(workspaceId: WorkspaceId): Promise<void>;
  /** A one-use proxy ticket for the shared screen, for the lease holder only (C7). */
  openTakeoverScreen(workspaceId: WorkspaceId): Promise<ScreenAccess>;
  screenAccess(id: BotId, mode: "view" | "control"): Promise<ScreenAccess>;
  startBotScreen(id: BotId): Promise<BotScreen>;
  /**
   * Take the shared browser over: every bot in the workspace is locked out until hand back. The
   * answer is the lease only; the screen opens through `openTakeoverScreen`.
   */
  takeOver(workspaceId: WorkspaceId, authorId?: string): Promise<{ lock: BrowserLock }>;
}

export function createComputerApi(t: HttpTransport): ComputerApi {
  return {
    async closeScreenAccess(id) {
      await t.json("POST", `/api/screen-access/${encodeURIComponent(id)}/close`, {});
    },
    getBotScreen(id) {
      return t.json("GET", `/api/bots/${encodeURIComponent(id)}/screen`);
    },
    getWorkspace(id) {
      return t.json("GET", `/api/workspaces/${encodeURIComponent(id)}`);
    },
    async handBack(workspaceId) {
      await t.json<{ released: true }>(
        "POST",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/handback`,
      );
    },
    openTakeoverScreen(workspaceId) {
      return t.json(
        "POST",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/takeover/open-screen`,
      );
    },
    screenAccess(id, mode) {
      return t.json("POST", `/api/bots/${encodeURIComponent(id)}/screen/access`, { mode });
    },
    startBotScreen(id) {
      return t.json("POST", `/api/bots/${encodeURIComponent(id)}/screen/start`, {});
    },
    takeOver(workspaceId, authorId) {
      return t.json(
        "POST",
        `/api/workspaces/${encodeURIComponent(workspaceId)}/takeover`,
        stripUndefined({ authorId }),
      );
    },
  };
}
