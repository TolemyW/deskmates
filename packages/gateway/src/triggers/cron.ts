// The cron trigger (design v0.3 §3.4). Once a minute, every bot's cron entries are matched
// against that minute; a match creates a run row on the background lane before anything else
// happens, and the scheduler starts it when the lane is free.
//
// Two properties the tick has to keep:
//
//   - Idempotent per minute. The trigger reference carries the minute, so a tick delivered twice,
//     a Gateway restarted inside the same minute, and a clock that went backwards all find the
//     run that already exists and do nothing (test strategy §5, "clock going backwards").
//   - Overlap is a skip, not a queue. "A cron trigger is skipped and logged if the previous round
//     has not finished": the skip is a `log` event on the run that is still going, because an
//     `approval` event would claim something a human has to answer.

import { type BotDefinition, type ParsedCron, cronMatches, parseCron } from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { EventBus } from "../events/bus.js";
import type { EventStore } from "../ledger/events.js";
import type { RunStore } from "../ledger/runs.js";

/** How long between ticks once the first one has landed on a minute boundary. */
export const CRON_TICK_INTERVAL_MS = 60_000;

export interface CronRunnerDeps {
  bots: BotStore;
  runs: RunStore;
  events: EventStore;
  /** The knob configuration stamped on every run row, including `cronTimeZone`. */
  runConfig: () => Record<string, unknown>;
  /** IANA zone the schedules are read in; undefined means the process zone. */
  timeZone: string | undefined;
  /** Asked for a scheduling pass after a run row is created. */
  kick: () => void;
  /** The SSE fan-out: a fired entry publishes its run's `queued` frame like any other trigger. */
  bus: EventBus;
  clock?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /** A paused bot's matching entry was skipped (ADR-0026 amendment 1); the Gateway tells its chat. */
  onPausedSkip?: (bot: BotDefinition, entry: number, schedule: string) => void;
}

/** The minute `date` falls in, as an ISO timestamp with seconds and milliseconds zeroed. */
export function minuteKey(date: Date): string {
  return new Date(
    Math.floor(date.getTime() / CRON_TICK_INTERVAL_MS) * CRON_TICK_INTERVAL_MS,
  ).toISOString();
}

/** `cron:<entry index>:<minute>` — the run row's trigger reference and its idempotency key. */
export function cronTriggerRef(entry: number, minute: string): string {
  return `cron:${entry}:${minute}`;
}

export class CronRunner {
  private readonly clock: () => Date;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;
  /** Parsed expressions, keyed by the expression text; parsing is pure and worth caching. */
  private readonly parsed = new Map<string, ParsedCron>();
  private startTimer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly deps: CronRunnerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** Starts ticking on the next minute boundary, then once a minute. Timers are unref'd. */
  start(): void {
    if (this.startTimer || this.interval) return;
    const delay = CRON_TICK_INTERVAL_MS - (this.clock().getTime() % CRON_TICK_INTERVAL_MS);
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      this.safeTick();
      this.interval = setInterval(() => this.safeTick(), CRON_TICK_INTERVAL_MS);
      this.interval.unref();
    }, delay);
    this.startTimer.unref();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.interval) clearInterval(this.interval);
    this.startTimer = undefined;
    this.interval = undefined;
  }

  /** One pass over every bot's cron entries for the minute `now` falls in. */
  tick(now: Date = this.clock()): void {
    const minute = minuteKey(now);
    for (const bot of this.deps.bots.list()) {
      bot.cron.forEach((entry, index) => {
        let schedule: ParsedCron;
        try {
          schedule = this.scheduleOf(entry.schedule);
        } catch (err) {
          // A bad expression reached the row before this module validated one; it is the
          // operator's to fix, and it must not stop the other bots' entries.
          this.log("cron entry has an unusable schedule", {
            botId: bot.id,
            entry: index,
            schedule: entry.schedule,
            error: String(err),
          });
          return;
        }
        if (!cronMatches(schedule, now, this.deps.timeZone)) return;
        // ADR-0026 amendment 1: a paused bot's entry is skipped, not queued for later. The
        // Gateway log names each skipped round; the bot's private chat is told once per pause.
        if (bot.pausedAt !== undefined) {
          this.log("cron round skipped: the bot is paused", {
            botId: bot.id,
            entry: index,
            schedule: entry.schedule,
            minute,
            pausedAt: bot.pausedAt,
          });
          this.deps.onPausedSkip?.(bot, index, entry.schedule);
          return;
        }
        this.fire(bot, index, entry.schedule, entry.prompt, minute);
      });
    }
  }

  private fire(
    bot: BotDefinition,
    index: number,
    schedule: string,
    prompt: string,
    minute: string,
  ): void {
    const triggerRef = cronTriggerRef(index, minute);
    if (this.deps.runs.findByTriggerRef(bot.id, triggerRef)) return;
    const live = this.deps.runs.findLiveByTriggerPrefix(bot.id, "cron", `cron:${index}:`);
    if (live) {
      this.deps.events.append({
        runId: live.id,
        kind: "log",
        payload: { source: "cron", skipped: true, entry: index, schedule, minute },
      });
      this.log("cron round skipped: the previous one has not finished", {
        botId: bot.id,
        entry: index,
        schedule,
        minute,
        runId: live.id,
        status: live.status,
      });
      return;
    }
    const run = this.deps.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef,
      triggerPayload: { prompt, schedule, entry: index },
      config: this.deps.runConfig(),
    });
    this.log("cron fired", { botId: bot.id, entry: index, minute, runId: run.id });
    this.deps.bus.publish({ type: "run_status", run });
    this.deps.kick();
  }

  private scheduleOf(expression: string): ParsedCron {
    const cached = this.parsed.get(expression);
    if (cached) return cached;
    const parsed = parseCron(expression);
    this.parsed.set(expression, parsed);
    return parsed;
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (err) {
      this.log("cron tick failed", { error: String(err) });
    }
  }
}
