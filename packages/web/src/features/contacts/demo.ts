// Demo routes of Contacts and the bot profile: the bot list, creating a bot, model, schedule,
// role and avatar edits, SOUL.md and MEMORY.md with version checks, and memory consolidation.
// Versions, the diary and "Run now" (ADR-0043) are in `demo-bot-editing.ts`.

import {
  type BotAvatar,
  type BotDefinition,
  type SoulProposal,
  type WorkspaceId,
  applySoulEdits,
  isBotAvatar,
} from "@deskmates/contracts";
import type { DemoFeature, DemoRequest } from "../../demo/feature.js";
import { type Result, created, notFound, ok } from "../../demo/result.js";
import { type DemoState, ignoreCancelled, summary } from "../../demo/state.js";
import { finishLater } from "../../demo/team.js";
import { botEditingRoute, recordDemoSave } from "./demo-bot-editing.js";

export const demo: DemoFeature = { route };

// The demo makes no model call: a vision capability stays unconfirmed, and a SOUL draft is a
// scripted targeted edit (a "Focus" section) so the preview, diff and apply flow can be tried.
const proposals = new WeakMap<DemoState, Map<string, SoulProposal>>();

function proposalsOf(s: DemoState): Map<string, SoulProposal> {
  let map = proposals.get(s);
  if (!map) {
    map = new Map();
    proposals.set(s, map);
  }
  return map;
}

function demoRoute(req: DemoRequest, s: DemoState): Result | undefined {
  const { method, body: b } = req;
  let x: RegExpMatchArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/workspaces\/([^/]+)\/model-capabilities$/)) && method === "GET") {
    const bots = s.bots.filter((bot) => bot.workspaceId === x?.[1]);
    const modelOf = (bot: (typeof bots)[number]) => bot.model ?? s.config().defaultModel;
    const models = new Set(bots.map(modelOf));
    models.add(s.config().defaultModel);
    return ok({
      capabilities: [...models].sort().map((model) => ({
        model,
        vision: { id: null, model, status: "unknown", reason: "not_probed" },
        visionPolicy: "deliver",
        botIds: bots.filter((bot) => modelOf(bot) === model).map((bot) => bot.id),
      })),
    });
  }
  if (req.match(/^\/api\/workspaces\/[^/]+\/model-capabilities\/vision\/probe$/))
    return {
      status: 202,
      json: {
        probe: {
          id: "probe_demo",
          model: String(b.model ?? ""),
          status: "unknown",
          reason: "job_failed",
          error: "The demo has no model to test.",
        },
      },
    };
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/bots\/([^/]+)\/welcome$/)) && method === "POST") {
    const bot = s.bot(x[1]);
    return bot ? { status: 202, json: { ok: true } } : notFound("bot");
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/bots\/([^/]+)\/soul-proposals$/)) && method === "POST") {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const soul = s.souls.get(bot.id) ?? { body: "", version: "v0" };
    const instruction = String(b.instruction ?? "").trim();
    const edited = applySoulEdits(soul.body, [], `## Focus\n${instruction}`);
    const id = `soulp_demo_${proposalsOf(s).size + 1}`;
    const proposal: SoulProposal = {
      id,
      botId: bot.id,
      mode: soul.body.trim() ? "edit" : "create",
      instruction,
      status: edited.ok ? "ready" : "failed",
      baseVersion: soul.version,
      baseBody: soul.body,
      proposedBody: edited.ok ? edited.body : null,
      runId: null,
      error: edited.ok ? null : "nothing to draft",
      appliedVersion: null,
      requestedBy: "human:demo",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    proposalsOf(s).set(id, proposal);
    return { status: 202, json: { proposal } };
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/bots\/([^/]+)\/soul-proposals\/([^/]+)(\/apply|\/discard)?$/))) {
    const proposal = proposalsOf(s).get(x[2] ?? "");
    if (!proposal || proposal.botId !== x[1]) return notFound("proposal");
    if (x[3] === "/discard") {
      proposal.status = "discarded";
      return ok({ proposal });
    }
    if (x[3] === "/apply") {
      const soul = s.souls.get(proposal.botId as BotDefinition["id"]) ?? {
        body: "",
        version: "v0",
      };
      if (proposal.status !== "ready" || soul.version !== proposal.baseVersion)
        return {
          status: 409,
          json: { code: "invalid_transition", message: "SOUL changed; draft again", details: {} },
        };
      const next = {
        body: proposal.proposedBody ?? "",
        version: `v${Number(soul.version.slice(1)) + 1}`,
      };
      s.souls.set(proposal.botId as BotDefinition["id"], next);
      proposal.status = "applied";
      proposal.appliedVersion = next.version;
      return ok({ proposal, soul: next });
    }
    return ok({ proposal });
  }
  return undefined;
}

function route(req: DemoRequest, s: DemoState): Result | Promise<Result> | undefined {
  const handled = demoRoute(req, s) ?? botEditingRoute(req, s);
  if (handled) return handled;
  const { method, path, query: q, body: b } = req;
  const m = (re: RegExp) => req.match(re);
  let x: RegExpMatchArray | null;
  if (path === "/api/bots" && method === "GET") {
    const ws = q.get("workspaceId");
    const bots = ws ? s.bots.filter((bot) => bot.workspaceId === ws) : s.bots;
    // #113 §3.2: a name lookup answers only the named bots.
    if (q.has("ids")) {
      const named = new Set((q.get("ids") ?? "").split(","));
      return ok({ bots: bots.filter((bot) => named.has(bot.id)) });
    }
    // #113 slice B: with paging parameters, one page by name with server search and the total.
    if (q.has("offset") || q.has("limit") || q.has("q")) {
      const needle = (q.get("q") ?? "").toLowerCase();
      const matches = bots
        .filter((bot) => `${bot.name} ${bot.role}`.toLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const offset = Number(q.get("offset") ?? 0) || 0;
      const limit = Number(q.get("limit") ?? 50) || 50;
      return ok({
        bots: matches.slice(offset, offset + limit),
        offset,
        limit,
        total: matches.length,
      });
    }
    return ok({ bots });
  }
  if (path === "/api/bots" && method === "POST") {
    const bot = s.addBot(String(b.name), String(b.role ?? ""), b.workspaceId as WorkspaceId, "");
    if (typeof b.model === "string") bot.model = b.model;
    if (isBotAvatar(b.avatar)) bot.avatar = b.avatar;
    return created({ bot });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)$/)) && method === "PATCH") {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    if ("model" in b) {
      if (b.model) bot.model = String(b.model);
      else (bot as { model?: string | undefined }).model = undefined;
    }
    if ("cheapModel" in b) {
      if (b.cheapModel) bot.cheapModel = String(b.cheapModel);
      else (bot as { cheapModel?: string | undefined }).cheapModel = undefined;
    }
    if (Array.isArray(b.cron)) bot.cron = b.cron as BotDefinition["cron"];
    if (typeof b.role === "string") bot.role = b.role;
    // ADR-0043 decision 1: the fields that were create-time, and the pause flag.
    if (typeof b.name === "string" && b.name !== bot.name) {
      if (!/^[\w-]+$/.test(b.name) || s.bots.some((o) => o.id !== bot.id && o.name === b.name))
        return {
          status: 400,
          json: { code: "validation", message: "That name is not free", details: {} },
        };
      bot.name = b.name;
    }
    if (Array.isArray(b.connectors)) bot.connectors = b.connectors as string[];
    if (Array.isArray(b.messageAllowlist)) bot.messageAllowlist = b.messageAllowlist as string[];
    const mutable = bot as {
      effort?: BotDefinition["effort"] | undefined;
      thinking?: BotDefinition["thinking"] | undefined;
      pausedAt?: string | undefined;
      pausedBy?: string | undefined;
    };
    if ("effort" in b) mutable.effort = (b.effort ?? undefined) as BotDefinition["effort"];
    if ("thinking" in b) mutable.thinking = (b.thinking ?? undefined) as BotDefinition["thinking"];
    if (b.paused === true && !bot.pausedAt) {
      mutable.pausedAt = new Date().toISOString();
      mutable.pausedBy = "human:demo";
    } else if (b.paused === false) {
      mutable.pausedAt = undefined;
      mutable.pausedBy = undefined;
    }
    if ("avatar" in b) {
      if (isBotAvatar(b.avatar)) bot.avatar = b.avatar;
      else (bot as { avatar?: BotAvatar | undefined }).avatar = undefined;
    }
    return ok({ bot });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/soul$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const soul = s.souls.get(bot.id) ?? { body: "", version: "v0" };
    if (method === "PATCH") {
      if (b.expectedVersion !== soul.version)
        return {
          status: 409,
          json: { code: "conflict", message: "SOUL.md changed since it was loaded", details: {} },
        };
      const next = {
        body: String(b.body ?? ""),
        version: `v${Number(soul.version.slice(1)) + 1}`,
      };
      s.souls.set(bot.id, next);
      bot.soulVersion += 1;
      recordDemoSave(s, bot.id, "soul", next.body);
      return ok({ soul: next });
    }
    return ok({ soul });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/memory$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const note = s.notes.get(bot.id) ?? { body: "", version: "n0" };
    if (method === "PATCH") {
      if (b.expectedVersion !== note.version)
        return {
          status: 409,
          json: {
            code: "conflict",
            message: "MEMORY.md changed since it was loaded",
            details: {},
          },
        };
      const next = {
        body: String(b.body ?? ""),
        version: `n${Number(note.version.slice(1)) + 1}`,
      };
      s.notes.set(bot.id, next);
      recordDemoSave(s, bot.id, "memory", next.body);
      return ok({ memory: next });
    }
    return ok({ memory: note });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = m(/^\/api\/bots\/([^/]+)\/memory\/consolidate$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const run = s.newRun(bot, undefined, "cron", "consolidate", "background");
    void finishLater(s, run, 1500, summary(""), "silent").catch(ignoreCancelled);
    return ok({ run });
  }
  return undefined;
}
