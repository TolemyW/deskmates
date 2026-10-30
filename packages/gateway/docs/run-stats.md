# Bot self-observability: `run_stats` (ADR-0050)

A bot whose Owner or Admin turned the setting on gets one read-only tool, `run_stats`, that
answers how the bot itself is doing: its own runs, failures, spend, pending approvals, parked
runs and tasks. It is off by default. Offering it is a strategy change (AGENTS.md): compare a bot
with and without it on paired runs before relying on it; no paired evaluation has been run yet.

## Setting

| Route | Who | Body / answer |
|---|---|---|
| `GET /api/bots/:id/run-stats` | Member or above of the bot's workspace | `{runStats: {botId, enabled, updatedAt?, updatedBy?}}` |
| `PUT /api/bots/:id/run-stats` | Owner or Admin | `{enabled: boolean}`; same answer |

A row in `bot_run_stats` means on. Each change writes one `bot.run_stats_set` audit row with the
setting before and after; a `PUT` that changes nothing writes none. The bot editor's
**Run statistics** section is the switch in the web UI.

## Freeze

When attempt 1 of a run starts, the Gateway writes `runs.config_json.runStats`: `"self-v1"` if the
bot has the setting, else `"off"`. A resume or a restart continuation reads it back, whatever the
setting says by then. A Gateway job (`runType` set: approval reviews, summaries, probes) is always
`"off"`; a run from before ADR-0050 that is past its first start has no key and is off. The tool is
in the start request's `tools` (`scheduler/sidecar-tools.ts`) only when the run froze `"self-v1"`.

## The internal route

`GET /internal/runs/:runId/run-stats?windowDays=N` on the sandbox listener, with that run's token.
`windowDays` is an integer from 1 to 30, default 7; any other query parameter is a 400
`validation`. A run that did not freeze `"self-v1"` is a 403 `forbidden`; another run's token is a
401 `token_rejected`. The bot and the workspace come from the run row, and every query filters on
both (`run-stats/run-stats-query.ts`).

The answer (`RunStatsReport` in contracts) has:

- `current` and `previous`: two windows of whole UTC days on `runs.created_at` (the current one
  ends today). Each has the runs by status and lane, the ADR-0042 failure classes of `failed`
  runs, the count of Gateway jobs and of runs in a person's private chat, the durations of
  finished runs (median, 90th percentile, maximum, total) and the spend.
- Spend is `CostQueryStore.summary` for the workspace, the bot and the window's days, the figure
  Costs shows: `knownCostUsd` is `null` when nothing is priced, never zero, and
  `estimatedCostUsd` (the ADR-0032 average-price estimate) is never added to it.
- `trend`: current minus previous for runs, failed runs, the success share (`succeeded` plus
  `silent` over terminal runs), known USD and the median duration; `null` where either side is
  unknown.
- `now`: executing runs, pending approvals (id, run, kind, tool name, since), parked runs (id,
  status, lane, created) and the bot's own tasks (`owner_bot_id`) by status with the open ones
  listed (id, status, title, updated). Each list holds at most 20 entries and its `total`.

Never in the answer: run error text, run summaries and replies, message bodies, approval
summaries or inputs, tool inputs or outputs, another bot's or another workspace's rows. A run in
a private chat is a count. Task titles are the only free text; the sidecar puts them in an
`<untrusted source="tasks">` block, entity-escaped, after the JSON.

The answer is computed on each call from the ledger. No model, embedding or rerank service is
called; `CostQueryStore` stores a run's usage summary when it has none, as Costs does.

This scope is what the tool returns, not a boundary between bots: anything in the shared
workspace stays readable to every bot in it (ADR-0004).
