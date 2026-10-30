# @deskmates/observability-dashboards

The Grafana dashboards of run observability (ADR-0046 decision 7) as one panel spec, written for
each engine through a dialect layer of five macros. Its output, `observability/grafana/<engine>/`
at the repository root, is committed and is what `scripts/stable/stable.sh grafana start` mounts
into Grafana from the active release.

## Rules

- **Dev-only, imports nothing.** No other package imports it and it imports no other package. Its
  tests read the sqlite sink's schema (`packages/gateway/observability/sqlite.sql`) as a file, to
  compile every query against it; the web's tests read the generated agent runs dashboard the
  same way. Nothing runs it in production: Grafana reads the committed output.
- **Views only.** A query reads the obs views of `src/views.ts` (ADR-0046 decision 1) and nothing
  else. `spec.test.ts` compiles every query, with Grafana's variables substituted, in a SQLite
  database that holds those views' columns as tables and no base table, so naming `run_events` or
  a ledger table fails; it also runs each query against the real schema.
- **Five macros, no other engine-specific SQL.** `src/dialect.ts`: `hourBucket`, `median`,
  `regexExtract`, `timeDiffMs`, `jsonField`. Anything else a panel needs that engines spell
  differently is a defect in the spec. The obs model keeps timestamps as ISO-8601 UTC text and
  precomputes durations, so time filtering is a text comparison (`inRange`) and needs no macro.
  Percentiles are not a macro: `src/percentiles.ts` writes the nearest-rank method with
  `row_number()` and `count(*)` windows and integer arithmetic, which every engine spells the same
  (ADR-0046 amendment 2 decision 19).
  Two portability habits the macros cannot enforce: group and join on columns made non-NULL with
  `coalesce`, and filter NULLs out before ordering by a nullable column.
- **Generated, never edited.** `src/generated.test.ts` regenerates everything and fails when a
  committed file differs or an extra file is there. Refresh from the repository root with
  `UPDATE_GENERATED=1 npx vitest run packages/observability-dashboards/src/generated.test.ts`
  (or `npm run generate -w packages/observability-dashboards`).

## Layout

- `src/spec.ts`: the spec's types (dashboard, section, panel, variable with an optional default),
  `inRange`, `variable`, and `RUN_VIEW` (the agent runs dashboard's uid, slug and `run` variable,
  which the web's run drawer links to).
- `src/dashboards/`: one file per dashboard and `index.ts`, the sorted list: agent runs
  (`agent-runs.ts`, with the failure retrospective) and the owner's four focus areas of ADR-0046
  amendment 2, model latency (`model-latency.ts`), prompt cache (`prompt-cache.ts`), approvals
  (`approvals.ts`) and tool calls (`tool-calls.ts`). Phase 2 adds silent runs and tasks.
- `src/percentiles.ts`: p50 to p99 by nearest rank, as plain SQL shared by every engine.
- `src/dialect.ts`: the `Dialect` interface and the `sqlite` dialect. `regexExtract` takes the
  portable subset `^? literal (.*?|.+?) literal|$`, which every engine can run, and refuses any
  other pattern.
- `src/engines.ts`: per engine, the Grafana datasource plugin, the shape of a query target, the
  datasource provisioning file and the in-container paths `stable.sh` mounts.
- `src/grafana.ts`: a spec as Grafana dashboard JSON (rows, grid layout, units, run links).
- `src/generate.ts`: every output file; `src/generated.test.ts` is its only writer.

## The macro table

| Macro | Meaning | sqlite |
| --- | --- | --- |
| `hourBucket(ts)` | start of the hour, ISO-8601 UTC text | `strftime('%Y-%m-%dT%H:00:00Z', ts)` |
| `median({from, value, by})` | a relation: the `by` columns and `median` | `row_number()` and `count(*)` windows, mean of the middle one or two |
| `regexExtract(text, pattern)` | first capture, or NULL | `instr` and `substr` |
| `timeDiffMs(later, earlier)` | milliseconds; `NOW` for the current time | `julianday` difference times 86400000 |
| `jsonField(json, keys)` | scalar at a key path, or NULL | `json_extract` |

`dialect.test.ts` expands every macro in every dialect and runs the sqlite expansions in SQLite
against a JavaScript reference (for `regexExtract`, the same pattern as a `RegExp` with the dotAll
flag). No panel uses `jsonField`: none of the views exposes a JSON column. `percentiles.test.ts`
runs the percentile helper in SQLite against a nearest-rank JavaScript reference.

## Display thresholds

A threshold on a dashboard (the failure retrospective's minimum similarity) is a dashboard
variable that filters what a panel shows. Nothing stores or decides by it (ADR-0046 decisions 10
and 26); every match is stored unfiltered.

## Adding a dashboard or an engine

A dashboard is a new file in `src/dashboards/` and one line in `index.ts`; then regenerate. An
engine (phase 2: `postgres`) is a `Dialect`, an `Engine` in `engines.ts` and one entry in each of
`DIALECTS` and `ENGINES`; the tests then cover it, and `spec.test.ts` needs a way to compile its
SQL (a T2 file against a real server) before its output is trusted.
