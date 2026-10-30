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
//     `approval` event would claim something a human has to answer. A round parked on a human
//     (an approval or a continuation ask) says so, once and then at most hourly, in the bot's
//     private chat (ADR-0029 decision 12); a round the platform parked resumes by itself and
//     needs no notice.
//
// And one property across a stop (ADR-0029 decision 11): a minute that passed while the Gateway
// was stopped is not fired later. The next start logs, per entry, which minutes nobody fired; an
// entry with `misfire: "run_once"` fires one catch-up round for the latest of them instead.

import {
  type BotDefinition,
  PARKED_RUN_STATUSES,
  type ParsedCron,
  cronMatches,
  parseCron,
} from "@deskmates/contracts";
import type { BotStore } from "../bots/bots.js";
import type { EventBus } from "../events/bus.js";
import type { EventStore } from "../ledger/events.js";
import type { RunRecord, RunStore } from "../ledger/runs.js";

/** How long between ticks once the first one has landed on a minute boundary. */
export const CRON_TICK_INTERVAL_MS = 60_000;

/** Decision 12: after the first notice about a parked round, at most one more per this long. */
export const PARKED_SKIP_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** Decision 11: how far back a start looks for missed minutes; an older stop is truncated. */
export const MISFIRE_LOOKBACK_MINUTES = 7 * 24 * 60;

/** Decision 11: how many skipped minutes one log line names; the count is always complete. */
export const MISFIRE_NAMED_MINUTES_MAX = 60;

/** The `runs.config_json` key that stamps a cron round created while the Gateway drained. */
export const QUEUED_IN_DRAIN = "queuedInDrain";

/** What a start found an entry missed while the Gateway was stopped (decision 11). */
export interface CronMisfire {
  botId: string;
  entry: number;
  schedule: string;
  /** The first `MISFIRE_NAMED_MINUTES_MAX` missed minutes, oldest first. */
  minutes: string[];
  count: number;
  /** The stop was longer than `MISFIRE_LOOKBACK_MINUTES`; only that much was searched. */
  truncated: boolean;
  /** `run_once`: the run of the one catch-up round, when it fired. */
  caughtUpRunId?: string;
}

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
  /** ADR-0029 decision 1: the Gateway drains, so a round created now is stamped for decision 11. */
  draining?: () => boolean;
  /**
   * ADR-0029 decision 12: a round parked on a human skipped this tick; the Gateway tells the bot's
   * private chat. Called for the first such skip and then at most once per hour per parked round.
   */
  onParkedSkip?: (
    bot: BotDefinition,
    parked: RunRecord,
    entry: number,
    schedule: string,
    minute: string,
  ) => void;
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

  /**
   * Ticks the current minute at once, so a Gateway starting at 09:00:20 still fires `0 9 * * *`
   * (`catchUp` covers only the minutes before it), then on the next minute boundary and once a
   * minute after it. A tick is idempotent per minute. Timers are unref'd.
   */
  start(): void {
    if (this.startTimer || this.interval) return;
    this.safeTick();
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
        // One entry that cannot fire (a busy database, a bad row) must not cost every later
        // entry and bot this minute.
        try {
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
          this.fire(bot, index, entry.schedule, entry.prompt, minute, now);
        } catch (err) {
          this.log("cron entry could not fire", {
            botId: bot.id,
            entry: index,
            schedule: entry.schedule,
            minute,
            error: String(err),
          });
        }
      });
    }
  }

  private fire(
    bot: BotDefinition,
    index: number,
    schedule: string,
    prompt: string,
    minute: string,
    now: Date,
  ): RunRecord | undefined {
    const triggerRef = cronTriggerRef(index, minute);
    if (this.deps.runs.findByTriggerRef(bot.id, triggerRef)) return undefined;
    const live = this.deps.runs.findLiveByTriggerPrefix(bot.id, "cron", `cron:${index}:`);
    if (live) {
      this.deps.events.append({
        runId: live.id,
        kind: "log",
        payload: { source: "cron", skipped: true, entry: index, schedule, minute },
      });
      this.noteParkedSkip(bot, live, index, schedule, minute, now);
      this.log("cron round skipped: the previous one has not finished", {
        botId: bot.id,
        entry: index,
        schedule,
        minute,
        runId: live.id,
        status: live.status,
      });
      return undefined;
    }
    const run = this.deps.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef,
      triggerPayload: { prompt, schedule, entry: index },
      config: {
        ...this.deps.runConfig(),
        // Decision 11: such a round is cancelled as a misfire if it can launch only late.
        ...(this.deps.draining?.() ? { [QUEUED_IN_DRAIN]: true } : {}),
      },
    });
    this.log("cron fired", { botId: bot.id, entry: index, minute, runId: run.id });
    this.deps.bus.publish({ type: "run_status", run });
    this.deps.kick();
    return run;
  }

  /**
   * ADR-0029 decision 11, once at start: every minute in `(lastAlive, now)` an entry matched was
   * missed while no Gateway ran. Each entry that missed any gets one log line naming them; an
   * entry with `misfire: "run_once"` fires one round for the latest of them, never more. The
   * current minute is the regular tick's. `lastAlive` is when the previous Gateway was last seen;
   * without one (a first start) nothing was missed.
   */
  catchUp(lastAlive: string | undefined, now: Date = this.clock()): CronMisfire[] {
    if (lastAlive === undefined) return [];
    const last = Date.parse(lastAlive);
    if (Number.isNaN(last)) return [];
    const current = Date.parse(minuteKey(now));
    const floor = current - MISFIRE_LOOKBACK_MINUTES * CRON_TICK_INTERVAL_MS;
    const first = Math.max(Date.parse(minuteKey(new Date(last))) + CRON_TICK_INTERVAL_MS, floor);
    const truncated = Date.parse(minuteKey(new Date(last))) + CRON_TICK_INTERVAL_MS < floor;
    const found: CronMisfire[] = [];
    for (const bot of this.deps.bots.list()) {
      bot.cron.forEach((entry, index) => {
        let schedule: ParsedCron;
        try {
          schedule = this.scheduleOf(entry.schedule);
        } catch {
          return;
        }
        const minutes: string[] = [];
        let count = 0;
        let latest: string | undefined;
        let latestFired: string | undefined;
        for (let t = first; t < current; t += CRON_TICK_INTERVAL_MS) {
          const at = new Date(t);
          if (!cronMatches(schedule, at, this.deps.timeZone)) continue;
          // `lastAlive` lags the previous Gateway's death by up to a tick: a minute it fired
          // before it stopped was not missed.
          if (this.deps.runs.findByTriggerRef(bot.id, cronTriggerRef(index, at.toISOString()))) {
            latestFired = at.toISOString();
            continue;
          }
          count += 1;
          latest = at.toISOString();
          if (minutes.length < MISFIRE_NAMED_MINUTES_MAX) minutes.push(latest);
        }
        if (count === 0 || latest === undefined) return;
        const misfire: CronMisfire = {
          botId: bot.id,
          entry: index,
          schedule: entry.schedule,
          minutes,
          count,
          truncated,
        };
        this.log("cron minutes skipped while the Gateway was stopped", { ...misfire });
        // `run_once` never fires a round older than one that already ran.
        const newest = latestFired === undefined || latest > latestFired;
        if (entry.misfire === "run_once" && bot.pausedAt === undefined && newest) {
          const fired = this.fire(bot, index, entry.schedule, entry.prompt, latest, now);
          if (fired) misfire.caughtUpRunId = fired.id;
        }
        found.push(misfire);
      });
    }
    return found;
  }

  /**
   * ADR-0029 decision 12: the round that made this tick skip is parked on a human. The first such
   * skip is a notice, then at most one per hour; a round the platform parked resumes by itself.
   */
  private noteParkedSkip(
    bot: BotDefinition,
    live: RunRecord,
    entry: number,
    schedule: string,
    minute: string,
    at: Date,
  ): void {
    if (!PARKED_RUN_STATUSES.has(live.status) || live.status === "waiting_platform") return;
    const now = at.getTime();
    const last = Date.parse(String(live.config.parkedSkipNoticeAt ?? ""));
    if (!Number.isNaN(last) && now - last < PARKED_SKIP_NOTICE_INTERVAL_MS) return;
    this.deps.runs.setConfig(live.id, { parkedSkipNoticeAt: new Date(now).toISOString() });
    this.deps.events.append({
      runId: live.id,
      kind: "log",
      payload: { source: "cron", op: "parked_skip_notice", entry, schedule, minute },
    });
    this.deps.onParkedSkip?.(bot, live, entry, schedule, minute);
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
