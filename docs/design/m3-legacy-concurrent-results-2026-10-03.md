# M3 concurrent legacy import before actual SDK execution

Date: 2026-10-03 (Asia/Taipei). Selected UX-01 startup T2 passes: **one test,
zero failure/skip**, one invocation. The run uses a real current-image Colima
workspace, the production SQLite Gateway, production sidecar and actual SDK.
The upstream is a local scripted Anthropic-protocol fixture, not a real model.
This closes the simultaneous legacy-startup prerequisite left by the previous
management browser check; full M3 and configured-model/strategy acceptance remain
incomplete. No production code, knob, commit, image alias or deployment changes.

## Protocol and observed result

The fixture starts one owned shared workspace and two bots, writes distinct
SOUL and manual MEMORY bytes into both actual home directories, then seeds only
those bots' canonical database fields as null to represent migrated legacy bots.
No SDK or model request has run at that point. This complements the prior actual
pre-0019 populated migration receipt; it is not another populated upgrade.

Two separate one-bot threads each receive exactly one reserved task message,
submitted in parallel. The first main SDK request from each bot waits at the
scripted upstream until the other arrives, with a 30-second barrier bound. At
both arrivals, both actual run rows are running, all four original canonical
bodies/versions are already in SQLite, and completed production file-read
results from the real container match each original file hash. Duplicate
concurrent import reads are observed; they return the same historical bytes.

Both arrivals occur at `2026-10-02T18:53:08.718Z` and `.720Z`; the barrier records
actual overlap before releasing either response. Each actual SDK then executes
one readonly Bash `cat` of its own SOUL/MEMORY. Its ledger tool result includes
its distinct manual-note marker. Both runs succeed at attempt 1 with distinct
SDK sessions. After both finish, independent container reads match each
StartRunRequest's canonical SOUL and generated MEMORY bytes exactly, and SQLite
still contains each original manual note exactly. Generated MEMORY includes the
preserved human notes and canonical wrapper; it is not the raw historical file.
The run config records the same canonical versions as the request.

The beta ledger also records one peer MEMORY change: alpha's concurrent startup
rewrites its historical raw notes to the canonical generated wrapper. Its diff
preserves the exact notes and matches the known before/after hashes. The event
says `peer_file_changed_during_run` and `restoredOnNextRun: false`; it is an
observation, not actor attribution or a per-bot file-access boundary. It is
retained rather than incorrectly reported as a clean absence of changes.

## Binding and accounting

Artifacts are in ignored `spikes/m3-legacy-concurrent-20261003/work-01/`:
test-source copy, `legacy-import-proof.json`, Vitest JSON/log, invocation and image
metadata, source inventory, one retained SQLite ledger, exact ownership journal,
cleanup and independent audit. Repeatable test and runner live outside work-01.

| Binding | Exact value |
| --- | --- |
| Test source SHA-256 | `8d9d53d81ecf486ec898a7cf77c611aa2f22f1668fd3805348c8130fdcb553f1` |
| Runner SHA-256 | `aac22993a6d19623a2a20ae90e45aad80f1e1b1a675242ccf9de56a3e7ffca1d` |
| Workspace image | `sha256:7e76493462b0f9a8484ae421a0a8dbf2ecb23e71a00deefefab447c5232c6bfc` |
| Egress image | `sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f` |
| Proof SHA-256 | `9982c304da0e8fcff16706f201b526d45e6294cabbee404c99a0102fb84ca327` |
| Ledger SHA-256 | `e73a1accf7b9f6f3cdf7c6ddeb5f7be3622ad75496ef1220dd19a58c3703df80` |
| Logical runs / physical SDK attempts | 2 / 2; no reserved task resubmissions |
| Scripted /v1/messages responses | 4; genuine real-model calls 0 |

The 918 initial runtime input hashes remain unchanged after the invocation.
All 64 acceptance-support/root dependency-config inputs additionally match the
previous frozen `17cc1157` inventory; this supplemental hash comparison was
performed after the run, separately from the initial inventory. The immutable
workspace image is reused from the independently bound current local build in
`m3-file-browser-results-2026-10-03.md`, with unchanged relevant source/compiled
inputs. No image build or dependency download occurs for this invocation.

Retained ledger usage is synthetic: alpha input 33459 / output 78; beta input
33454 / output 78; both cache counts 0 and cost unknown (`null`). These are fake
upstream accounting values, not real spending, cache measurements or model ability.
The existing stack records a 900-second/50-turn per-run configuration; the test's
240-second case and 540-second whole-invocation bounds cap this mechanical check.
Neither limit extends the authorization for the pending real-model campaign.

Initial new-test static checks exposed undefined-index and non-null-assertion
errors, which were corrected before dispatch. Final backend/acceptance typecheck
and lint pass. Production and T0/T1 test inputs did not change; the separately
recorded latest T0/T1 result remains 2462 passes. This selected new T2 case is
not pooled into the older frozen full 88-pass T2 result or called a new full T2.

## Cleanup and remaining gates

The bounded runner exits zero, with no deadline or retry; its PID is independently
gone. The retained ledger has exactly two successful attempt-1 runs, distinct
sessions, both real tool-call/result sequences and valid usage rows. Backup is
saved through the open handle; SQLite integrity is `ok` and foreign keys have
no violations. All six exact owned identities (two containers, private network,
three volumes) are independently absent. Stable services and the shared outbound
network are untouched; no prefix cleanup is used.

This proves selected actual startup/import ordering and byte preservation.
Configured-model domain tasks, actual continuation/restart protocols, full memory
lifecycle/scoped trials, automatic context coverage, paired strategy evaluation,
live WhatsApp and browser disk landing still need their own required evidence.
