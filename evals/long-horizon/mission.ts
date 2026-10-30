// Declarative, versioned inputs. Validation runs before Docker or a model is contacted.
import type { CronEntry } from "@deskmates/contracts";

export type Verdict = "pass" | "fail" | "unknown";
export type Comparison = "eq" | "gte" | "lte";
export type Oracle =
  | { name: string; type: "eligible_tickets" }
  | { name: string; type: "run_status"; in: string[] }
  | { name: string; type: "run_attempt"; op: Comparison; value: number }
  | { name: string; type: "answer"; value: string }
  | {
      name: string;
      type: "file_regex_count";
      path: string;
      regex: string;
      op: Comparison;
      value: number;
    }
  | { name: string; type: "oplog_mutations"; ops?: string[]; op: Comparison; value: number }
  | { name: string; type: "phase_mutations"; op: Comparison; value: number }
  | { name: string; type: "tickets_swept"; comment: string; op: Comparison; value: number }
  | {
      name: string;
      type: "orders_new";
      customerId: string;
      sku: string;
      quantity: number;
      op: Comparison;
      value: number;
    }
  | { name: string; type: "no_unexpected_changes"; allowed: string[] };

export interface Phase {
  id: string;
  inject?: "gateway_restart";
  trigger?: { kind: "message"; text: string } | { kind: "cron"; entry: number; at: string };
  /** Only an exact fixture checkout action may be decided. No generic approval automation. */
  approval?: { decision: "allow_once" | "deny"; holdSeconds: number; toolName: string };
  checkpoints: Oracle[];
}

export interface Mission {
  id: string;
  version: string;
  suite: string;
  description: string;
  expected: { tickets: string[] };
  budgets: {
    maxTurns: number;
    runTimeoutSeconds: number;
    shortWaitSeconds: number;
    missionWallSeconds: number;
  };
  bot?: { cron: CronEntry[] };
  phases: Phase[];
  final: Oracle[];
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${at}: expected object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${at}: expected nonempty string`);
}

function integer(
  value: unknown,
  at: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error(`${at}: invalid integer`);
}

function strings(value: unknown, at: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v))
    throw new Error(`${at}: expected strings`);
}

function oracles(value: unknown, at: string, final: boolean): asserts value is Oracle[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${at}: at least one oracle is required`);
  const names = new Set<string>();
  for (const [index, item] of value.entries()) {
    const p = `${at}[${index}]`;
    const o = object(item, p);
    text(o.name, `${p}.name`);
    if (names.has(o.name)) throw new Error(`${p}: duplicate oracle name`);
    names.add(o.name);
    if (["run_status", "run_attempt", "answer"].includes(String(o.type)) && final)
      throw new Error(`${p}: final oracle must use independent state`);
    switch (o.type) {
      case "run_status":
        strings(o.in, `${p}.in`);
        if (!o.in.length) throw new Error(`${p}: empty statuses`);
        break;
      case "answer":
        text(o.value, `${p}.value`);
        break;
      case "file_regex_count":
        text(o.path, `${p}.path`);
        if (!o.path.startsWith("/work/") || o.path.split("/").includes(".."))
          throw new Error(`${p}: file must be inside /work`);
        text(o.regex, `${p}.regex`);
        new RegExp(o.regex.replaceAll("{tickets}", "(?:1003)"), "gm");
        break;
      case "oplog_mutations":
        if (o.ops !== undefined) strings(o.ops, `${p}.ops`);
        break;
      case "eligible_tickets":
      case "phase_mutations":
      case "run_attempt":
        break;
      case "tickets_swept":
        text(o.comment, `${p}.comment`);
        break;
      case "orders_new":
        text(o.customerId, `${p}.customerId`);
        text(o.sku, `${p}.sku`);
        integer(o.quantity, `${p}.quantity`, 1);
        break;
      case "no_unexpected_changes":
        strings(o.allowed, `${p}.allowed`);
        break;
      default:
        throw new Error(`${p}: unknown oracle type`);
    }
    if (
      !["run_status", "answer", "no_unexpected_changes", "eligible_tickets"].includes(
        String(o.type),
      )
    ) {
      if (!["eq", "gte", "lte"].includes(String(o.op))) throw new Error(`${p}: invalid comparison`);
      integer(o.value, `${p}.value`);
    }
  }
}

export function parseMission(json: string): Mission {
  const m = object(JSON.parse(json), "mission");
  for (const key of ["id", "version", "suite", "description"]) text(m[key], key);
  if (!/^[a-zA-Z0-9_-]+$/.test(String(m.id))) throw new Error("id: use letters, digits, - or _");
  const expected = object(m.expected, "expected");
  strings(expected.tickets, "expected.tickets");
  if (new Set(expected.tickets).size !== expected.tickets.length)
    throw new Error("expected.tickets: duplicates");
  const budgets = object(m.budgets, "budgets");
  integer(budgets.maxTurns, "budgets.maxTurns", 1, 100);
  integer(budgets.runTimeoutSeconds, "budgets.runTimeoutSeconds", 1, 900);
  integer(budgets.shortWaitSeconds, "budgets.shortWaitSeconds", 1, 60);
  integer(budgets.missionWallSeconds, "budgets.missionWallSeconds", 1, 14_400);
  let cronCount = 0;
  if (m.bot !== undefined) {
    const bot = object(m.bot, "bot");
    if (!Array.isArray(bot.cron)) throw new Error("bot.cron: expected array");
    cronCount = bot.cron.length;
    // One cron entry avoids a synthetic tick accidentally starting unrelated jobs.
    if (cronCount > 1) throw new Error("bot.cron: at most one entry in this harness");
    for (const entry of bot.cron) {
      const e = object(entry, "cron entry");
      text(e.schedule, "cron.schedule");
      text(e.prompt, "cron.prompt");
    }
  }
  if (!Array.isArray(m.phases) || !m.phases.length)
    throw new Error("phases: expected nonempty array");
  const ids = new Set<string>();
  const ticks = new Set<string>();
  for (const item of m.phases) {
    const p = object(item, "phase");
    text(p.id, "phase.id");
    if (ids.has(p.id)) throw new Error("phase.id: duplicate");
    ids.add(p.id);
    if ((p.inject === undefined) === (p.trigger === undefined))
      throw new Error(`${p.id}: exactly one trigger or injection`);
    if (p.inject !== undefined && p.inject !== "gateway_restart")
      throw new Error(`${p.id}: unsupported injection`);
    if (p.trigger !== undefined) {
      const t = object(p.trigger, `${p.id}.trigger`);
      if (t.kind === "message") text(t.text, `${p.id}.text`);
      else if (t.kind === "cron") {
        integer(t.entry, `${p.id}.entry`, 0, cronCount - 1);
        text(t.at, `${p.id}.at`);
        if (
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/.test(t.at) ||
          !Number.isFinite(Date.parse(t.at))
        )
          throw new Error(`${p.id}: tick must be a UTC minute`);
        if (ticks.has(t.at)) throw new Error(`${p.id}: duplicate cron tick`);
        ticks.add(t.at);
      } else throw new Error(`${p.id}: unknown trigger`);
    }
    if (p.approval !== undefined) {
      if (p.inject !== undefined) throw new Error(`${p.id}: injection has no approval`);
      const a = object(p.approval, `${p.id}.approval`);
      if (a.decision !== "allow_once" && a.decision !== "deny")
        throw new Error(`${p.id}: invalid decision`);
      integer(a.holdSeconds, `${p.id}.holdSeconds`, 0, 60);
      text(a.toolName, `${p.id}.toolName`);
      if (!a.toolName.endsWith("browser_click"))
        throw new Error(`${p.id}: only fixture browser clicks may be preauthorised`);
    }
    oracles(p.checkpoints, `${p.id}.checkpoints`, false);
  }
  oracles(m.final, "final", true);
  if (!(m.final as Oracle[]).some((o) => o.type === "no_unexpected_changes"))
    throw new Error("final: side-effect invariant is required");
  return m as unknown as Mission;
}

export function verdict(checks: readonly { status: Verdict }[]): Verdict {
  if (checks.some((c) => c.status === "fail")) return "fail";
  return checks.length === 0 || checks.some((c) => c.status === "unknown") ? "unknown" : "pass";
}

/** Every wait shares a fixed absolute deadline; resuming never renews it. */
export function remainingMs(
  deadline: number,
  now = Date.now(),
  cap = Number.POSITIVE_INFINITY,
): number {
  return Math.max(0, Math.min(cap, deadline - now));
}
