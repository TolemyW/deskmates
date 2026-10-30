# Workspace execution limits

ADR-0005 amendment 5 and ADR-0016 amendment 2 (issue #61), owner-decided on 2026-10-14. The
counters that bound a conversation and a run are per-workspace settings, set by an Owner or Admin
and audited. Message counts do not cut work off by default: the turn budget and the volume rule
are off until a workspace turns them on; the relay cap, the hop-depth ceiling and the repetition
rule stay on as runaway guards.

## The counters

| Setting | Counts | Default | Range | `off` |
|---|---|---|---|---|
| `turnBudget` | bot-authored messages in one thread since its budget origin (the latest human message or the last unpause) | off | 1 to 300 | yes |
| `turnBudgetResetMinutes` | minutes after which a turn-budget pause ends by itself ([thread pauses](thread-pauses.md)) | 60 | 5 to 1440 | no |
| `relayCountMax` | hop depth of one message chain, inherited through `message_bot` | 5 | 1 to 50 | yes |
| `maxTurns` | SDK assistant turns per physical attempt | `DESKMATES_MAX_TURNS` (80) | 1 to 1000 | yes |
| `continuationLimit` | continuations offered after turn exhaustion | 2 | 0 to 20 | yes |
| `continuationWindowHours` | time to answer a continuation request | 24 | 1 to 168 | no |

They measure different things and are not one conversation limit.

## Switches

| Switch | Default | Meaning |
|---|---|---|
| `volumeBreaker` | off | arms the loop breaker's volume rule (300 bot messages since the latest human message pause the thread) |
| `requireBudgetForOff` | off | "require a budget for unlimited limits": `off` is refused without a weekly or cumulative monetary limit, and every limit that would be off resolves to a number with source `default_no_backstop` (a stored `off` to the key's default, the turn budget's default `off` to the thread row's `turn_budget`, 8) |

## Precedence and freezing

- The message caps are read when a bot message is stored: the workspace setting, else off
  (`turnBudget`) or the fixed `RELAY_COUNT_MAX` (`relayCountMax`). The thread row's `turn_budget`
  is used only under `requireBudgetForOff` without a budget. A change applies to the next bot
  message; it never unpauses a thread or wakes a mention that was already dropped.
- The run limits are resolved when attempt 1 starts and written to `runs.config_json`
  (`maxTurns`, `continuationLimit`, `continuationWindowHours`, `limitSources`, `limitsVersion: 1`).
  Resumes, continuations and budget continuations use the frozen values. Model jobs keep their
  fixed `maxTurns` of 1.
- `maxTurns` `off` sends `maxTurns: null`; the sidecar omits the SDK option and gives no turn
  warning. `continuationLimit` 0 fails the first exhaustion; `off` asks every time.

## `off` and the money backstop

`off` is accepted whether or not the workspace has a monetary limit (ADR-0032), unless
`requireBudgetForOff` is on. With the switch on and no limit, the stored `off` stays but resolves
to the default with source `default_no_backstop` until a limit is set or the switch is turned off.

## Loop breaker

Gateway constants, not settings. On every bot message stored in a thread:

- **depth** (always on): `relay_count` above 50 wakes nobody (the cross-thread rule:
  `relay_count` follows a chain into `bus` threads);
- **volume** (off unless `volumeBreaker`): 300 bot messages since the latest human message pause
  the thread;
- **repetition** (always on): a bot's third identical message (trimmed, whitespace collapsed,
  case folded) since the latest human message pauses the thread.

A breaker pause ends on the next human message, like a turn-budget pause. Every breach writes
`cap_breached {cap, limit, source, rule?}`.

## API

- `GET /api/workspaces/:id/limits` (Member): stored settings, `switches`, effective values with
  sources, defaults (`null` is off), ranges, breaker thresholds and `budgetBackstop`.
- `PUT /api/workspaces/:id/limits` (Owner or Admin, role action `limits.set`): a limit key with a
  value sets it, `null` clears it, an omitted key is unchanged; a switch takes `true` or `false`.
  One `workspace.limits_set` audit row per change, its before and after listing the stored
  settings and the switches that are on.
- `GET /api/threads/:id` and the membership routes return `effectiveTurnBudget`
  (`{value, source}`): the turn budget the router enforces for that thread, `value: null` when it
  is off. The chat info panel shows this, not the stored `thread.turnBudget`.
