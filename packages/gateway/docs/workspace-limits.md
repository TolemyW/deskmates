# Workspace execution limits

ADR-0005 amendment 5 and ADR-0016 amendment 2 (issue #61). The fixed counters that bound a
conversation and a run are per-workspace settings, set by an Owner or Admin and audited. The
defaults are unchanged, so a workspace that stores nothing behaves as before.

## The counters

| Setting | Counts | Default | Range | `off` |
|---|---|---|---|---|
| `turnBudget` | bot-authored messages in one thread since its latest human message | the thread row (8) | 1 to 100 | yes |
| `relayCountMax` | hop depth of one message chain, inherited through `message_bot` | 5 | 1 to 50 | yes |
| `maxTurns` | SDK assistant turns per physical attempt | `DESKMATES_MAX_TURNS` (80) | 1 to 1000 | yes |
| `continuationLimit` | continuations offered after turn exhaustion | 2 | 0 to 20 | yes |
| `continuationWindowHours` | time to answer a continuation request | 24 | 1 to 168 | no |

They measure different things and are not one conversation limit.

## Precedence and freezing

- The message caps are read when a bot message is stored: the workspace setting, else the thread
  row (`turnBudget`) or the fixed `RELAY_COUNT_MAX` (`relayCountMax`). A change applies to the next
  bot message; it never unpauses a thread or wakes a mention that was already dropped.
- The run limits are resolved when attempt 1 starts and written to `runs.config_json`
  (`maxTurns`, `continuationLimit`, `continuationWindowHours`, `limitSources`, `limitsVersion: 1`).
  Resumes, continuations and budget continuations use the frozen values. Model jobs keep their
  fixed `maxTurns` of 1.
- `maxTurns` `off` sends `maxTurns: null`; the sidecar omits the SDK option and gives no turn
  warning. `continuationLimit` 0 fails the first exhaustion; `off` asks every time.

## `off` and the money backstop

`off` is accepted only while the workspace has a weekly or cumulative monetary limit (ADR-0032).
If that limit is cleared later, the stored `off` stays but resolves to the default with source
`default_no_backstop`.

## Loop breaker

Not a setting. On every bot message stored in a thread:

- **depth**: `relay_count` above 50 wakes nobody (the cross-thread rule: `relay_count` follows a
  chain into `bus` threads);
- **volume**: 100 bot messages since the latest human message pause the thread;
- **repetition**: a bot's third identical message (trimmed, whitespace collapsed, case folded)
  since the latest human message pauses the thread, only when a cap is relaxed (`off` or above
  its default).

A breaker pause ends on the next human message, like a turn-budget pause. Every breach writes
`cap_breached {cap, limit, source, rule?}`.

## API

- `GET /api/workspaces/:id/limits` (Member): stored settings, effective values with sources,
  defaults, ranges, breaker thresholds and `budgetBackstop`.
- `PUT /api/workspaces/:id/limits` (Owner or Admin, role action `limits.set`): a key with a value
  sets it, `null` clears it, an omitted key is unchanged. One `workspace.limits_set` audit row per
  change.
