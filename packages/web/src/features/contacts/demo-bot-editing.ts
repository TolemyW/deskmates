// Demo routes for a bot after creation (ADR-0043): SOUL/MEMORY versions with restore, the diary
// with line deletes, and "Run now". The demo has no container: the diary is two scripted days,
// and a restore writes the version's body back through the demo's own SOUL/MEMORY copies.

import type {
  BotDefinition,
  BotRuleFile,
  BotRuleVersion,
  BotRuleVersionSummary,
} from "@deskmates/contracts";
import type { DemoRequest } from "../../demo/feature.js";
import { type Result, notFound, ok } from "../../demo/result.js";
import { type DemoState, ignoreCancelled, summary } from "../../demo/state.js";
import { finishLater } from "../../demo/team.js";

const histories = new WeakMap<DemoState, Map<string, BotRuleVersion[]>>();
const diaries = new WeakMap<DemoState, Map<string, Map<string, string[]>>>();

function historyOf(s: DemoState, botId: string, file: BotRuleFile): BotRuleVersion[] {
  let map = histories.get(s);
  if (!map) {
    map = new Map();
    histories.set(s, map);
  }
  const key = `${botId}:${file}`;
  let list = map.get(key);
  if (!list) {
    list = [];
    const current = (file === "soul" ? s.souls : s.notes).get(botId as BotDefinition["id"]);
    if (current?.body) list.push(version(file, 1, current.body, "migration"));
    map.set(key, list);
  }
  return list;
}

function version(
  file: BotRuleFile,
  n: number,
  body: string,
  createdBy: string,
  restoredFrom?: number,
): BotRuleVersion {
  return {
    file,
    version: n,
    body,
    // The demo has no hashing; the number stands in for the body's identity.
    bodySha256: `demo-${file}-${n}`,
    bytes: new TextEncoder().encode(body).length,
    createdBy,
    createdAt: new Date().toISOString(),
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  };
}

/** Record a save the demo's SOUL or MEMORY route made, as the Gateway's version table does. */
export function recordDemoSave(s: DemoState, botId: string, file: BotRuleFile, body: string) {
  const list = historyOf(s, botId, file);
  list.push(version(file, list.length + 1, body, "human:demo"));
}

function diaryOf(s: DemoState, bot: BotDefinition): Map<string, string[]> {
  let map = diaries.get(s);
  if (!map) {
    map = new Map();
    diaries.set(s, map);
  }
  let days = map.get(bot.id);
  if (!days) {
    days = new Map([
      [
        "2026-10-15",
        [
          `- 09:02 run run_demo_a (cron) completed: ${bot.role || "checked in"}`,
          "- 11:40 run run_demo_b (thread_message) completed: answered a question in chat",
        ],
      ],
      ["2026-10-14", ["- 16:15 run run_demo_c (thread_message) silent"]],
    ]);
    map.set(bot.id, days);
  }
  return days;
}

const dayView = (day: string, lines: string[]) => ({
  day,
  lines,
  version: `demo-${day}-${lines.length}`,
});

export function botEditingRoute(req: DemoRequest, s: DemoState): Result | undefined {
  const { method, body: b } = req;
  let x = req.match(/^\/api\/bots\/([^/]+)\/rule-versions\/(soul|memory)(?:\/(\d+))?(\/restore)?$/);
  if (x) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const file = x[2] as BotRuleFile;
    const list = historyOf(s, bot.id, file);
    if (x[3] === undefined && method === "GET") {
      const versions: BotRuleVersionSummary[] = [...list]
        .reverse()
        .map(({ body: _body, ...rest }) => rest);
      const newest = list.at(-1);
      return ok({
        file,
        versions,
        ...(newest ? { lastRun: { runId: "run_demo_a", version: newest.version } } : {}),
      });
    }
    const target = list.find((item) => item.version === Number(x?.[3]));
    if (!target) return notFound("version");
    if (x[4] === undefined) return ok({ version: target });
    const store = file === "soul" ? s.souls : s.notes;
    const current = store.get(bot.id) ?? { body: "", version: file === "soul" ? "v0" : "n0" };
    const next = {
      body: target.body,
      version: `${current.version.slice(0, 1)}${Number(current.version.slice(1)) + 1}`,
    };
    store.set(bot.id, next);
    list.push(version(file, list.length + 1, target.body, "human:demo", target.version));
    return ok({ [file]: next, version: list.length, appliesFromNextRun: false });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/bots\/([^/]+)\/diary(?:\/([0-9-]+))?(\/delete-line)?$/))) {
    const bot = s.bot(x[1]);
    if (!bot) return notFound("bot");
    const days = diaryOf(s, bot);
    if (x[2] === undefined)
      return ok({
        days: [...days.entries()].map(([day, lines]) => ({
          day,
          bytes: new TextEncoder().encode(lines.map((line) => `${line}\n`).join("")).length,
        })),
      });
    const lines = days.get(x[2]) ?? [];
    if (x[3] !== undefined && method === "POST") {
      const index = Number(b.line);
      if (lines[index] !== b.text)
        return {
          status: 409,
          json: { code: "invalid_transition", message: "The diary changed", details: {} },
        };
      lines.splice(index, 1);
    }
    return ok({ day: dayView(x[2], lines) });
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: route matching
  if ((x = req.match(/^\/api\/bots\/([^/]+)\/cron\/(\d+)\/run$/)) && method === "POST") {
    const bot = s.bot(x[1]);
    const entry = bot?.cron[Number(x[2])];
    if (!bot || !entry) return notFound("cron entry");
    const run = s.newRun(bot, undefined, "manual", `manual:${x[2]}`, "background");
    void finishLater(s, run, 1500, summary("Ran the schedule on request."), "succeeded").catch(
      ignoreCancelled,
    );
    return { status: 202, json: { run } };
  }
  return undefined;
}
