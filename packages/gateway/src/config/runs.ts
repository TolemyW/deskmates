// Run knobs: delivered slice size, waits, deadlines, turns, group routing, the bot working
// directory, cron zone and webhook limits. Most are recorded in `runs.config_json` (AGENTS.md).

import {
  type BotWorkdirMode,
  DeskmatesError,
  type GroupRouting,
  SHORT_WAIT_SECONDS_DEFAULT,
  isGroupRouting,
} from "@deskmates/contracts";
import { type Env, optionalInt } from "./env.js";

/** ADR-0005 definitions: delivered slice cap, a guess to be calibrated. */
export const THREAD_PAYLOAD_MAX_TOKENS_DEFAULT = 16000;

/**
 * Wall-clock deadline for one sidecar process. A run past it is killed and failed; without it a
 * hung MCP attach or a stalled poll holds the bot's lane until a Gateway restart. Benchmark tasks
 * allow 10 minutes; the default leaves room for a long browser session and an L2 short wait.
 */
export const RUN_TIMEOUT_SECONDS_DEFAULT = 1800;

/**
 * Largest webhook body the Gateway accepts, in bytes. The body is stored on the run row and put
 * in the model's context as untrusted data, so an unbounded one is both a database and a token
 * problem; anything larger is 413 and no run row is created.
 */
export const WEBHOOK_BODY_MAX_BYTES_DEFAULT = 65536;

/**
 * How many webhook deliveries one bot may have queued. Each delivery is its own run, queued
 * behind the running one on the background lane (design v0.3 §3.4, "the background lane queue
 * has an upper bound"); past the cap the sender gets 429 `queue_full` instead of a run row.
 */
export const WEBHOOK_QUEUE_MAX_DEFAULT = 20;

/**
 * SDK `maxTurns` for one run: how many assistant turns a sidecar may take before the loop stops.
 * A knob, so it is recorded in `runs.config_json` and a change is a strategy change (AGENTS.md).
 * 80 leaves room for a long browser or research task without letting a looping agent spend a
 * lane and a token budget forever (issue #69: 50 was below what the stable deployment runs, and a
 * long-horizon task exhausted 50 turns in three of three runs). Exhaustion still parks for the
 * delegator (ADR-0016).
 */
export const MAX_TURNS_DEFAULT = 80;

/**
 * ADR-0005 amendment 2: an unaddressed human message is offered until one member takes it, the
 * taker owns the thread, and a group wake carries the roster. `walk-v1` is decision 4 as first
 * written, kept so the two can be compared on one build and switched back without a release.
 */
export const GROUP_ROUTING_DEFAULT: GroupRouting = "owner-v1";

export interface RunsConfig {
  threadPayloadMaxTokens: number;
  shortWaitSeconds: number;
  /** Recorded in `runs.config_json`; a change is a knob change (AGENTS.md). */
  runTimeoutSeconds: number;
  /**
   * How a message with no explicit recipient is routed in a group (ADR-0005 amendment 2).
   * Omitted means `GROUP_ROUTING_DEFAULT`. Recorded in `runs.config_json` as `groupRouting`.
   */
  groupRouting?: GroupRouting;
  /** Issue #88: opt-in per-bot working directory. Omitted means `shared`. */
  botWorkdir?: BotWorkdirMode;
  /** Non-secret strategy versions/hashes supplied by an evaluation or embedding host. */
  strategyEvidence?: Readonly<Record<string, string>>;
  /**
   * IANA zone cron schedules are evaluated in; undefined means the Gateway process's own zone.
   * Recorded in `runs.config_json`: the same expression fires at different instants under
   * different zones, so a result cannot be attributed without it.
   */
  cronTimeZone: string | undefined;
  /** Recorded in `runs.config_json`. */
  webhookBodyMaxBytes: number;
  webhookQueueMax: number;
  /** SDK `maxTurns` per run; recorded in `runs.config_json` and sent on every StartRunRequest. */
  maxTurns: number;
}

export function readRunsConfig(env: Env): RunsConfig {
  return {
    threadPayloadMaxTokens: optionalInt(
      env,
      "THREAD_PAYLOAD_MAX_TOKENS",
      THREAD_PAYLOAD_MAX_TOKENS_DEFAULT,
    ),
    shortWaitSeconds: SHORT_WAIT_SECONDS_DEFAULT,
    runTimeoutSeconds: optionalInt(env, "RUN_TIMEOUT_SECONDS", RUN_TIMEOUT_SECONDS_DEFAULT),
    groupRouting: groupRouting(env),
    botWorkdir: botWorkdir(env),
    cronTimeZone: cronTimeZone(env),
    webhookBodyMaxBytes: optionalInt(env, "WEBHOOK_BODY_MAX_BYTES", WEBHOOK_BODY_MAX_BYTES_DEFAULT),
    webhookQueueMax: optionalInt(env, "WEBHOOK_QUEUE_MAX", WEBHOOK_QUEUE_MAX_DEFAULT),
    maxTurns: optionalInt(env, "DESKMATES_MAX_TURNS", MAX_TURNS_DEFAULT),
  };
}

function groupRouting(env: Env): GroupRouting {
  const value = env.DESKMATES_GROUP_ROUTING?.trim() || GROUP_ROUTING_DEFAULT;
  if (!isGroupRouting(value))
    throw new DeskmatesError("validation", "DESKMATES_GROUP_ROUTING must be walk-v1 or owner-v1");
  return value;
}

/**
 * Issue #88 (ADR-0004 amendment 1): where a run starts. `shared` keeps `/work` and the prompt of
 * every earlier run; `per-bot` is an unmeasured strategy candidate, so it stays opt-in until a
 * paired campaign says otherwise. Recorded in `runs.config_json` as `botWorkdir`.
 */
function botWorkdir(env: Env): BotWorkdirMode {
  const value = env.DESKMATES_BOT_WORKDIR?.trim() || "shared";
  if (value !== "shared" && value !== "per-bot")
    throw new DeskmatesError("validation", "DESKMATES_BOT_WORKDIR must be shared or per-bot");
  return value;
}

/** `CRON_TIMEZONE`, rejected here rather than at the first tick if the zone is not an IANA one. */
function cronTimeZone(env: Env): string | undefined {
  const raw = env.CRON_TIMEZONE?.trim();
  if (raw === undefined || raw === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw new DeskmatesError("validation", "CRON_TIMEZONE must be an IANA time zone", { raw });
  }
  return raw;
}
