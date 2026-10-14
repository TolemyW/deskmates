# Actual SDK active-tool interruption and continuation expiry

Date: 2026-10-03 (Asia/Taipei). Selected UX-02 mechanics pass after a fixture
correction. Full M3 remains incomplete. Production Gateway, DockerProvider,
sidecar and SDK 0.3.278 run on local Colima with a scripted localhost upstream.
Real model calls: zero. No production source, release, commit, deployment or
stable-service changes were made.

## Invocation accounting

| Receipt | Scope and result | Actual SDK attempts |
| --- | --- | --- |
| `spikes/m3-sdk-interruption-20261003/work-01/` | Initial invocation exits 1 after its first active-tool SIGKILL/restart. The fixture incorrectly requires deletion of all token rows, although revoked rows are retained for audit for 24 hours. The closed ledger confirms the token was revoked. Remaining two expiry cases were not started | 1 |
| `work-02/` | Runner preflight references a nonexistent parent inventory after an overly broad path edit. Stops before a Gateway or SDK starts; preserved separately | 0 |
| `work-03/` | One predeclared corrected invocation, three tasks/three attempts, exits zero in 69.60 seconds. Token assertions now count only unrevoked/unexpired rows. Parent inventory paths are corrected. Per-attempt cap remains one turn/120 seconds; outer deadline 360 seconds | 3 |

Both real SDK invocations and the unstarted preflight remain visible. Total four
logical runs/four SDK physical attempts, with no configured-model calls. Only
three selected cases in the corrected invocation pass. The initial failure is
not reclassified as a passing whole invocation or a production defect.

## Observed protocol

The crash case starts actual SDK Bash: write a start marker, sleep eight seconds,
then write an end marker. Before SIGKILL the run is running, its physical sidecar
exec is incomplete, and sanitized `/proc` inspection shows both SDK and sidecar
processes inside the exact owned workspace. The new Gateway opens the same DB
and binds the same two ports, so the old process can reach the replacement.

Startup reconciliation fails the original attempt-1 run with `gateway restarted
while the run was live`, revokes its credential and dispatches no replacement
sidecar. An actual stale authenticated `ended` POST using the old short-lived
fixture token returns HTTP 401. The token is never printed or retained in the
receipt, and its temporary 0600 capture file is deleted.

The already executing local command **does finish after the Gateway crash**.
Its end marker is read through the actual bounded workspace file route. This
is a runtime boundary: a failed ledger row and revoked Gateway token do not mean
an already executing command was cancelled. The check does not claim isolation,
instant process cancellation or prevention of local workspace writes. No new
main model request is made. The orphan sidecar/SDK subsequently terminate;
sanitary process inspection returns an empty list before the next task starts.
The run remains failed despite the completed file write.

Two independent expiry cases first execute actual SDK tools and exhaust their
one-turn budgets into `waiting_continuation`. The original expiry timestamps
are approximately 24 hours ahead. Fixture control changes only those named
isolated runs' `config.continuationExpiresAt` to one second in the past, recording
both timestamps. It does not change production clocks or scheduling intervals.

| Expiry case | Result |
| --- | --- |
| Operator Continue after injected expiry | HTTP 409; the actual route settles deny as `system:expiry`, stops attempt 1 and retains the handoff in the summary. No resumed SDK attempt |
| Automatic maintenance after injected expiry | No manual tick/kick or operator decision. The actual one-minute scheduler timer settles deny as `system:expiry` after **34724 ms**, stops attempt 1 and retains the handoff. No resumed SDK attempt |

Both decisions retain reason `24-hour continuation window expired`. All pending
approvals are settled, all credentials revoked, and continuation counts stay
zero. Exactly the three reserved human messages exist; no bot reply is posted
and system notices consume no relay count. This proves expiry mechanics with
injected eligibility, not a 24-hour soak or configured-model handoff quality.

| Corrected logical run | Final state | Attempts |
| --- | --- | --- |
| `run_45138c95e4be46f49bf572fa41fba164` | failed on active Gateway crash | 1 |
| `run_bb3bf2a0a99543bda5a9099a315aa62c` | stopped by expired API decision | 1 |
| `run_5e4cab8c3b6a44ab9ac603254fb29d5f` | stopped by actual maintenance timer | 1 |

## Ledger, source and terminal verification

Independent collector opens both closed DBs read-only: integrity `ok`, no FK
violations, exact run states/attempts, revoked token timestamps and expiry
reasons. All four SDK requests have scripted proxy usage records: across both
invocations input **66715**, output **101**, cache read/create **0/0**. Only the
two normally parked SDK attempts deliver final run-usage rows: input **33415**,
output **33**. Each matches its proxy record. Both crash attempts lack final
SDK/run usage; their final coverage remains **unknown**, not zero or complete.
These are synthetic fixture quantities, not vendor billing.

Both invocation parents and their four Gateway PIDs are independently absent;
the four unique owned listeners refuse connections. Every exact journal ID is
absent: four containers, two workspace networks and six volumes. Shared outbound
network and unrelated resources are untouched. No fixture job remains active.

Each invocation binds 983 explicit inputs and pinned ARM64 images, with all
inputs unchanged at its termination. Corrected current source still matches
all 983; the three changed fixture files of the initial invocation retain their
frozen source/hashes. Compiled backend and image inputs remain unchanged from
the prior current-image receipt. No image rebuild, pull or dependency download.

Workspace image:
`sha256:7e76493462b0f9a8484ae421a0a8dbf2ecb23e71a00deefefab447c5232c6bfc`.
Egress image:
`sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.

| Corrected material | SHA-256 |
| --- | --- |
| Child | `7c430309fff7e3955bd8957a3ba04d28d9c7d9a42c1d9bb900a373f7416aec8c` |
| Probe | `c69497a0e529f343053b67980c5366ce5caac848cb7ea7e6151ad52ca30d31e9` |
| Runner | `cb5d4c946b48ed38b44d5b119b8f47c322c809ce2353b362cb17c5745e89bccf` |
| Inventory | `4fc86cce2a37a5ed8b29d77685411f3641f99cb5fc796a816ce0c0e3f82ca897` |
| Closed DB | `fe96f226ceed0e523dbc5d2beb862baa35a202bab522b29a740c92a1ab03804a` |
| Parent receipt | `e3d99fff425d191552b8628654b7b08801906db9d6e7755d127047430fbe3973` |
| Independent verification | `4acac3318d670cd265b2bb3114658953adb42c55048a57772272e4d37e987255` |

Initial closed DB SHA is
`add158807664bc445f5c7b0dc1de7a231e9c1bf25dbcad52988103ae5f40f706`;
its parent receipt SHA is
`cdcd658e7cfdefff0b6a6f402e51648e716e50f8a4cc87490f181b39c6fb580e`.
Both ledgers and verbatim dispatched child/probe plus hash-verified reconstructed
runner copies are retained. Standalone strict TypeScript including repository
indexed-access/exact-optional flags passes on corrected source; diff whitespace
checks pass. Existing T0/T1 and frozen full T2 counts were not rerun or expanded
by this spike.

## Remaining scope

Together with `m3-sdk-continuation-results-2026-10-03.md`, selected actual
SDK/container/process checks cover parked restart, continue/stop/cap, active
crash reconciliation and timestamp-injected API/timer expiry. They do not close
configured-model/delegator quality, complete memory lifecycle, automatic
compaction, a full 24-hour soak or paired strategy acceptance. WhatsApp requires
prepared configuration; the larger model campaign scope confirmation and native
browser manual-unlock request remain pending. Full M3 is not accepted.
