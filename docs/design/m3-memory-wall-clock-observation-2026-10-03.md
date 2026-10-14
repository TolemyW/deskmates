# Default-duration consolidation observation

Date: 2026-10-03 (Asia/Taipei). Status: first quiet boundary verified;
actual process restart verified; elapsed observation stopped on clock drift
before the 24-hour cooldown boundary.
No SDK/model calls, credential read, Docker resource or stable-service change.
M3 remains incomplete. This is a single no-model runtime observation, separate
from the pending expanded model campaign and WABA configuration.

## Missing evidence and declared observation

ADR-0011 A1 uses ten candidates or three closed episodes, ten quiet workspace
minutes, and a 24-hour per-bot cooldown. Earlier unit/integration and six-process
restart evidence verifies these predicates using controlled historical times;
it does not measure the actual elapsed durations. This observation keeps all
four production policy values and the natural 60-second scheduler sweep.
It never changes stored timestamps, injects Date, requests manual consolidation
or manually kicks the scheduler. Cron task generation is disabled; the
scheduler's ordinary sweep remains active.

The reserved sequence creates ten trusted synthetic candidates through a real
Gateway's authenticated HTTP completion path. It observes automatic consolidation
no earlier than 600000 ms after the interactive source finishes, then creates
ten distinct new candidates. It checks suppression after that second source's
own quiet window, gracefully shuts down the actual Gateway process, reopens the
same SQLite database in a new process, and observes the next consolidation no
earlier than 86400000 ms after the first consolidation's creation. Successful
completion must consume all twenty candidates without duplicate consolidations.
The first boundary has a 120-second observation allowance beyond its threshold;
the second has the same allowance. These account for the unchanged minute sweep
and 20-second read-only observation interval, not a lowered policy.

Wall time and monotonic elapsed time must remain within two seconds throughout.
A clock jump or timer failure retains a failed/partial receipt; there is no
replacement run. The outer service allows 89970 active seconds plus 30 seconds
termination grace (25 hours). All sidecars are synthetic; a throwing fetch guard
records any unexpected model request. This proves neither actual SDK/container
behavior nor learned-memory retention quality, poison safety, paired improvement
or full M3 acceptance.

## Candidate and startup evidence

The observation reuses the completed 42bab952 parent through read-only on-host
package/dependency links. All 967 frozen source files and 1708 compiled files
are hash-checked by the remote runner before execution and again at termination.
The candidate/runtime manifests and image evidence remain those in
`m3-memory-integrated-gate-results-2026-10-03.md`; this observation creates no
container and does not claim an additional T2 invocation.

The fixture initially had TypeScript closure-narrowing errors, repaired before
runtime invocation. A standalone compiler invocation also initially inherited
DOM libraries and conflicted with Node's Buffer BodyInit; the corrected command
uses the repository's ES2022-only library choice. Final strict checks pass with
noUncheckedIndexedAccess and exactOptionalPropertyTypes. Biome's stdin fix/check
returns zero and produces byte-identical source. No compilation or formatting
failure is counted as an SDK or model call.

The local startup smoke completes two synthetic interactive runs, producing
twenty candidates with zero consolidations before ten minutes, then backs up
and closes the fixture. Its actual PID 59798 and both listeners independently
inspect absent; the SQLite integrity/FK checks pass. The source was copied
before execution and matches child SHA256
`019d4e4a17c8ced4fd81894237398722f42670c42b01b7fb514ee4fd4dc18ee2`.
Smoke receipt SHA256:
`129c7006470da962547ad29ea1cee9cb4e5eb279c2afa4650f1bcb36039b5cc7`.
This is startup/HTTP/shutdown evidence, not a shortened elapsed-time trial.

Remote probe SHA256:
`89fd8e8beb43a74cb9cc091b99110061a9f44c8516e630a62b0f642fb2bca6e9`.
Runner SHA256:
`0614c8124fa34ffa9ea6038bd875872fdafb3d8349169cb36df08ee0fe103f83`.
Transferred six-file archive SHA256:
`1175dd398a59e09cfc1d5a0a932b7d995e36691acdb6b41ab0230e7ca8532ebd`.
The explicit inventory excludes credentials, .env, keys, history, dependencies
and unrelated data. Only the test code/package metadata and compiled-file hash
manifest were transferred. No heavy-test lock is held for a day: this fixture
uses only isolated loopback listeners, SQLite and synthetic providers, without
Docker/build/model workload.

## Verified live state

Remote directory:
`/home/owner/agent_workspace/deskmates-reusable-memory-wall-clock-20261003-01`.
Exact service: `deskmates-memory-wall-clock-20261003-01.service`.
Invocation ID: `588b71cfeea04863bd9cca9d83bbed54`.

At 2026-10-02 22:45:25 UTC (2026-10-03 06:45:25 Taipei), systemd reports loaded,
active/running with MainPID 4090571. Independent /proc checks bind that Python
runner, its probe PID 4090572, and the probe's actual Gateway child PID 4090603
through their expected command markers and parent identities. The runner
reports 967/1708 preflight hash checks. The actual source run
`run_4988fee80607449b8d4d29a99af524cf` is terminal silent with finishedAt
2026-10-02T22:44:27.902Z. Ten candidates exist; no consolidation exists and
the guarded model request count is zero. First eligible quiet time is
2026-10-02T22:54:27.902Z. The day boundary cannot yet be calculated until the
first automatic consolidation actually occurs.

This exact service is independently managed by the server and does not require
the initiating workstation's SSH connection. Its running state is not success.
Collect final source/runtime parity, per-process exits, ledger integrity/FKs,
timestamps/provenance and independent PID/group/listener absence before changing
the verdict. If the unit is garbage-collected, keep native exit status unknown
and inspect the saved receipts; do not reinterpret a missing unit's default zero
as a passed service.

## First boundary, independently verified

A consistent SQLite backup at 2026-10-02T22:56:18.028984+00:00 records the first
automatic consolidation `run_79449a3306864529871972352d769065` created at
22:55:27.865Z and completed `succeeded` at 22:55:27.872Z. The original interactive
source finished at 22:44:27.902Z, so the actual quiet interval before creation is
**659963 ms (10 minutes 59.963 seconds)**. This is after the unchanged ten-minute
threshold and within the unchanged natural minute-sweep allowance. Its recorded
consolidationPolicy remains episodes=3, candidates=10, idleMinutes=10,
cooldownHours=24. All first-source ten candidates are consumed by that exact run.

The second synthetic interactive source `run_7c97faca2ca74722bfadae27bda19db9`
finishes at 22:55:28.419Z. Its ten distinct candidates remain unconsumed; no
second consolidation exists. The future cooldown boundary is
**2026-10-03T22:55:27.865Z (2026-10-04 06:55:27.865 Taipei)**, measured from the
first consolidation's actual creation. No day-boundary, restart or complete
campaign claim is made yet. The probe's broad status label still says waiting
for ten-minute quiet until it finishes the second source's quiet check and
restarts; its saved quietBoundary and the independent database establish this
first transition rather than that stale label.

Two live captures retain the before/after database state. Capture 01 at
22:54:53.605495 UTC has the original ten unconsumed candidates and no
consolidation. Capture 02 has the successful first consolidation, consumed first
batch and unconsumed second batch. Both consistent snapshots pass integrity/FK
checks. The second has 38 complete observation records, zero incomplete lines,
maximum wall/monotonic drift 0.864 ms, zero guarded model calls and zero proxy
request rows. run_usage is empty: missing token measurements are unknown, not
zero. All three remote runs and the two preceding local-smoke runs are synthetic
sidecar executions, not SDK/model attempts.

Capture 01 audit/archive SHA256:
`ee7a38d900fc8882326b341833aaa3cd00ea91694fd62f0ad970cf78749b18ca` /
`53898f9dcfff58e0c26da54ff3a6657127503a1d1e0836b71930e7839ffd9900`.
Capture 02 audit/archive SHA256:
`f419a1f155e1cf392c4dce1a864d1521882d64e7dc6dcb062cacc21e25d5f787` /
`05bb9684f7d4a5123e1db3eb26dd70b39ad0d721336bd8844422776697355162`.
Local private artifacts live under
`spikes/m3-memory-wall-clock-20261003/work-remote-01/capture-01` and `capture-02`.
Every transferred member matches its explicit hash inventory; captured child,
probe and runner bytes match the dispatched source inventory. This closes the
selected elapsed quiet-boundary observation only. Full configured-model memory,
remaining runtime cases, quality/poison/paired gates and WABA stay open.

## Actual process restart and cooldown suppression

By 2026-10-02T23:06:33 UTC, scheduled graceful Gateway restart is complete.
Original PID 4090603 is independently absent; new PID 4107378 is live under
probe PID 4090572 and runner PID 4090571. Twenty candidates, consumed first
batch, pending second batch, single successful consolidation and original
cooldown boundary persist. The second source is now quiet beyond ten minutes;
the day cooldown, rather than recent activity, suppresses another consolidation.

Consistent capture at 23:19:07.088590 UTC verifies that state, integrity/FKs,
old PID absence and new process identity, with zero new SDK/proxy calls.
Capture 03 audit/archive SHA256:
`df6167323ec706e8390ebef67661387edaaca62bd584c3b68217dc154f4a8dc6` /
`ce29110f40439bbe992b241583db80701c5b91d644b412448bcdaa6d51e6d8db`.
This is restart persistence and observed suppression after fresh quiet time;
the actual 24-hour boundary remains pending.

At 2026-10-02T23:56:05.662163Z, capture 05 independently verifies the original
unit invocation, current process parents/start ticks/group, absent old Gateway
and its two listener ports, the live new Gateway ports and all 967 source/1708
compiled hashes. The ledger remains integral with no FK violations, twenty
candidates and one consolidation; actual quiet elapsed time remains 659963 ms
and cooldown remains pending. There are zero proxy/model-guard requests.
Terminal assertions remain null, and the live unit's default exit value remains
unknown. The read-only collector helper changed without changing or restarting
the running fixture. Its terminal branch awaits the genuine cooldown outcome.
Capture 04 retains the preceding helper version and live observations.

| Capture 05 material | SHA256 |
| --- | --- |
| Audit | a10c7d609f7f4776f823a20f3d595d0464ac0065ff1a4b1ac6a0e86f5a80346a |
| Archive | 5fc09f1b12fdaf582a3e8598685ce79cef64704f0e863047e9389172083c7102 |
| Shared collector helper | 2223d4a8de2bf5dfbce3006a3c14f5193fcbf975c37ff29536d34d71ddbf4010 |

## Live status correction at 2026-10-03 18:42 Taipei

Read-only polling of the exact original invocation at
2026-10-03T10:42:11.372562Z reports the unit and runner failed. A separate read
of the saved probe/runner status confirms
`wall/monotonic drift -2678.202508997172ms prevents valid timing attribution`.
This exceeds the declared two-second tolerance. The runner finished at
2026-10-03T05:43:06Z (13:43:06 Taipei), about 6 hours 59 minutes after startup.
The 24-hour cooldown boundary was not reached or verified. The cause of the
clock adjustment remains unestablished; this is failed/partial timing evidence,
not a demonstrated cooldown behavior defect.

The last frame retains twenty candidates and one successful consolidation;
the first ten-minute quiet boundary and process-restart observations above
remain partial evidence. There were zero guarded model requests. Both Gateway
exits are recorded as zero and independent /proc polling finds runner, probe
and Gateway absent. The runner reports 967 source/1708 compiled postflight
checks. This compact status check does not add independent listener cleanup
or final-ledger integrity verification. No fixture was restarted and no
replacement observation was launched. Local poll receipts remain in the
original work-remote-01 directory. Full-day evidence and M3 acceptance remain
open.
