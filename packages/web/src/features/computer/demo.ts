// Demo routes of the computer and the bots' desktops: takeover and handback of the workspace
// browser, and per-bot screens. The demo has no container, so a screen never becomes viewable.

import type { BotDefinition, BotId, BotScreen, WorkspaceId } from "@deskmates/contracts";
import type { GatewayEvent } from "../../api/types.js";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import type { DemoState } from "../../demo/state.js";

const store = (s: DemoState) =>
  s.store("computer", () => ({ screens: new Map<BotId, BotScreen["state"]>() }));

export const demo: DemoFeature = { route };

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/takeover$/))) {
    s.humanHolds = true;
    s.emit({
      type: "workspace_lock",
      workspaceId: decodeURIComponent(x[1] ?? "") as WorkspaceId,
      lock: null,
    } as unknown as GatewayEvent);
    return ok({
      browserLock: {
        workspaceId: x[1],
        holderKind: "human",
        acquiredAt: new Date().toISOString(),
      },
    });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/handback$/))) {
    s.humanHolds = false;
    return ok({ released: true });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/workspaces\/([^/]+)\/takeover\/open-screen$/))) {
    // The demo has no desktop to proxy (`takeoverScreen` is false), so it opens nothing.
    return {
      status: 503,
      json: { code: "sandbox_unavailable", message: "No screen in the demo", details: {} },
    };
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/screen$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    return ok(screen(s, bot));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/screen\/start$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    store(s).screens.set(bot.id, "unavailable");
    return ok(screen(s, bot));
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/screen\/access$/))) {
    return {
      status: 409,
      json: {
        code: "conflict",
        message: "Desktops need a real workspace container; this demo has none.",
        details: {},
      },
    };
  }
  if (m(/^\/api\/screen-access\/([^/]+)\/close$/)) return ok({ closed: true });
  return undefined;
}

function screen(s: DemoState, bot: BotDefinition): BotScreen {
  return {
    botId: bot.id,
    workspaceId: bot.workspaceId,
    state: store(s).screens.get(bot.id) ?? "stopped",
    humanHeld: s.humanHolds,
  };
}
