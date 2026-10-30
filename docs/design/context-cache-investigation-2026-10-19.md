# Stage 3 context and cache investigation

Date: 2026-10-19
Scope: issue #5 Stage 3 and issue #33 context/cache acceptance. Read-only
observations of the stable deployment plus controlled CPU construction. Zero
new inference calls, zero model tokens and zero production database writes.
No product configuration or caching behavior was changed by this work.

## What this establishes

Local context assembly is a small part of the measured wait. Existing agent
requests already report positive provider cache reads when they report that
field. The ledger cannot establish a one-third average-context reduction or
an increase in token-weighted cache share: both agent windows have no complete
input/cache-read/cache-create denominator, and the windows are not paired
tasks. Those strategy-effect gates remain pending.

No local static cache is selected. Every attempt creates a sidecar process,
so a module-local cache would not reuse an earlier attempt's construction.
Most fixed guidance is already held in module constants for that process;
the SOUL body can arrive in the start request's canonical files. A cross-run
cache would add freshness and lifecycle complexity for a small measured
envelope. Stage 4 persistent SDK/query hosts remain deferred.

## Population and reproducibility

The stable deployment was v0.7.6 when measured. Historical rows retain their
original frozen configuration; this does not reattribute old requests to
v0.7.6. The two windows are complete UTC days, 2026-10-16 and 2026-10-17,
selected before comparing their results because both contain agent work
after request-shape instrumentation landed. The later complete day,
2026-10-18, has 21 Messages requests, all `memory_recheck` jobs and no agent
requests; it cannot serve as an agent comparison window.

`evals/cache-analysis/report.py` was streamed to the test host's Python
interpreter and opened the stable SQLite file using `mode=ro` and
`query_only=ON`. It emits only aggregates and hashes. Each historical window
was read twice with the final analyzer and the outputs were identical.
The sanitized machine-readable receipt is
`evals/cache-analysis/results-2026-10-19.json`.

The inference population is exactly `request_kind = 'messages'`. The reader
excludes `count_tokens` and separates all model jobs, including title/activity
summaries. A count missing from the upstream is unknown, not a miss or zero.
The window selects request time; first-observed requests and context samples
of an attempt crossing a boundary are labelled accordingly by the tool.

| Observation | Oct 16 UTC | Oct 17 UTC |
|---|---:|---:|
| All Messages requests | 207 | 251 |
| Non-Messages requests excluded | 99 | 68 |
| Model-job Messages requests excluded from agent statistics | 85 | 46 |
| Agent Messages requests | 122 | 205 |
| Agent cache-read missing | 9 (7.38%) | 6 (2.93%) |
| Reported positive cache reads / reported cache reads | 113/113 | 199/199 |
| Agent cache-create missing | 122 (100%) | 205 (100%) |
| Agent input-token missing | 4 | 0 |
| Requests with a complete prompt-token denominator | 0 | 0 |
| Token-weighted cache-read share | unknown | unknown |
| Agent requests with cache-control markers | 122 | 205 |
| Distinct static system hashes | 8 | 6 |
| Agent attempts with Messages requests / full context samples | 13/13 | 9/9 |
| First observed request cache-read missing | 6/13 | 5/9 |

Every reported agent cache-read count is positive, but that is not a 100%
cache coverage claim: unknowns remain outside the request-hit denominator,
and a cache hit may cover only part of the prompt. `cache_create = NULL`
also prevents computing the total prompt tokens. In particular, the older
latency report's first-turn `unknown` bucket must not be counted as a cache
miss; its `turn_usage` population differs from the per-request proxy facts.

The JSON receipt retains fresh/resume start, new/resumed SDK session,
created/attached/cached sandbox, SDK retry presence and hashed frozen config.
There were no recorded SDK retry events in these agent cohorts. The common
configuration hash `5030d94353cff001` has 71 versus 114 fresh/new/cached
requests, 4 versus 10 fresh/resumed/cached requests and 4 versus 38
resume/resumed/cached requests. This imbalance and the changed schema size
rule out treating the days as a controlled improvement experiment. The
served model hash is also retained: Oct 16 has two reported hashes and four
unknowns; Oct 17 has one reported hash.

## Context size and local construction

These are the CLI's first `full` context-usage samples per selected attempt,
not reconstructed token estimates. Per-category medians need not sum to the
median total.

| Tokens, first full sample | Oct 16 p50 / p95 (n=13) | Oct 17 p50 / p95 (n=9) |
|---|---:|---:|
| Total | 32,805 / 71,150 | 33,355 / 38,509 |
| System prompt | 1,611 / 3,254 | 1,610 / 3,933 |
| Built-in system tools | 15,233 / 15,233 | 15,233 / 15,233 |
| MCP tools | 12,279 / 14,797 | 13,685 / 13,728 |
| Skills | 296 / 296 | 296 / 296 |
| Messages | 2,156 / 41,896 | 2,620 / 5,319 |

Tool schemas dominate these samples. A sidecar-only static string cache
does not reduce the provider's tool-schema tokens. Trimming the CLI surface
or mounting tools by run would change the model's available actions and
requires a separate one-knob paired strategy experiment. None was enabled.

The same-process timeline envelope from `sidecar_started` to `query_started`
is 346/449 ms p50/p95 on Oct 16 and 412/455 ms on Oct 17. It includes all
sidecar pre-query work, including context retrieval and setup; it does not
isolate context I/O. The full historical latency report had 170 agent runs,
26 without timeline marks, and 153 attempts with an attempt-start mark.
For warm cached containers with no retry, new SDK sessions observed their
first model request at p50 1,471 ms (n=46) and their end at p50 213,139 ms
(n=51); resumed SDK sessions observed the first request at p50 1,255 ms
(n=78) and their end at p50 101,626 ms (n=78). Different missing-stage
populations mean these medians must not be subtracted as a per-run estimate.
Cross-process timings retain the clock caveat in ADR-0037.

`evals/cache-analysis/context-construction.ts` then called the production
`buildContext` with synthetic files and a fixed clock: 100 warmups and 2,000
measured constructions of 48,077 characters, with no cache. On the
workstation's Node 23.6.0, p50 was 0.0268 ms, p95 0.0788 ms and max 3.22 ms.
This measures CPU/string/hash work only; it excludes filesystem I/O, imports,
process startup, SDK startup and the network. It is not a host comparison.
All identical constructions produced one static hash. Updating memory and
diary refreshed the user context while preserving the static hash; updating
SOUL changed the static hash. Those checks use actual controlled inputs.

## Verification and remaining gates

- Three Python regression cases pass: NULL usage and denominator handling,
  an empty window, and half-open window selection with jobs and count-token
  requests excluded from agent inference.
- The production-builder CPU measurement and refresh/invalidation assertions
  pass. No cache candidate was introduced, so this is not candidate replay.
- `evals/replay.test.ts` passes 19 model-free harness tests. There are no
  committed real-run trace fixtures in `evals/traces`; a production
  trajectory replay was not performed and is not claimed by this receipt.

The one-third context reduction and improved cache-share claim remain
unmeasured. They require a declared baseline/candidate pair, frozen model,
tool surface, tasks and memory, complete usage receipts, alternating runs,
and quality/fingerprint checks under the measurement protocol. The existing
observations cannot replace those inputs. No new real-model campaign was
started as part of this work.
