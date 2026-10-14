# M3 final per-response SDK usage repair

Date: 2026-10-03 Asia/Taipei. Selected production mechanics pass; full M3 open.
No real model, commit, release tag, deployment or new strategy knob.

## Defect and behavior

Actual SDK 0.3.278 emits assistant content-block envelopes before the final
message_delta. The previous tracker keeps the last envelope, so its provisional
output (1 in the scripted observation) incorrectly becomes the turn's total.
The final run usage and Gateway proxy already contain the correct output; the
defect concerns per-response ledger measurements.

The production sidecar now requests the SDK's public partial-message events.
message_start binds a response ID and model; cumulative delta counts replace
present measurements, with absent fields preserved and explicit null staying
unknown. message_stop commits the response once. Late blocks/duplicate frames
cannot reopen it. Streams are correlated by parent_tool_use_id so main and
nested responses do not overwrite each other. An interrupted stream's output
stays null even if a partial cumulative delta was received. A complete nonstreamed
assistant response still supplies final counts; a null/absent stop_reason does
not establish final output. Result/compaction/end flush outstanding responses.

Raw content deltas are not copied into the ledger or passed through another
model path. Existing complete assistant handling, prompts, tools, risk/approval
rules, taint, turn-budget warnings and SDK version are unchanged. Gateway pricing
continues to ignore SDK costUSD. This is observability framework work.

## Regression and actual runtime evidence

Six new tracker regressions fail before repair, four existing cases pass; all
ten pass after. They exercise final 132 instead of provisional 1, duplicate
blocks, optional/null/zero final fields, interleaved parent streams, interrupted
output, orphan frames and provisional envelopes without final evidence. A new
runOnce integration checks the public SDK option and final event handling.
Initial fixture typing mistakes are retained and corrected against the pinned
SDK's actual required Delta fields, without casts or runtime SDK in T0/T1.

Backend/acceptance typecheck and lint pass. Complete root T0/T1:
**2475 pass, zero fail/skip**. The selected actual SDK T2 is extended to compare
the two main response measurements with independently recorded Gateway proxy
rows, while keeping the compaction summarizer's third request separate.

Three actual SDK/container observations are retained under ignored
`spikes/m3-stream-usage-repair-20261003/work-01` through `work-03`:

| Work | T2 result | Meaning |
| --- | --- | --- |
| 01 | Failed; run succeeds | Fixture initially looks for modelRequests outside app.deskmates.ctx; usage oracle not reached |
| 02 | Failed; run succeeds | Corrected fixture on explicit old image; two ledger outputs are 1/1 while final proxy counts are 26/59. Other main input/cache counts match |
| 03 | Passed; run succeeds | Fresh repaired image; main ledger input/output/cache counts match both final proxy records. Automatic boundary, memory flush, exact archive prefix and original tool/result preservation still pass |

Each uses one logical/physical SDK attempt, four turns and 120 seconds. Three
attempts and nine scripted messages requests total, real model calls zero.
Before-image receipts explicitly distinguish edited host sources from the old
immutable workspace image; they never claim that image includes the new tracker.
Source/compiled hashes are unchanged at each invocation's termination; later
fixture/typing revisions are recorded separately. No failures are overwritten.

Work-03 run `run_80709ac77c014a74a8ad3072dfb4e183`, session
`1a05a4a1-448a-45fd-b2f0-fe034cf3d961`, attempt 1, succeeds. Two main turns
report output 26 and 59. Summarizer output 41 is a separate proxy request. Final
run usage includes all three: synthetic input 228716, output 126, cache 0/0,
cost null. Main windows, summary spend and the run aggregate are not conflated.
The selected Vitest invocation exits zero, one pass/no fail/skip, 9.40 seconds.

The final arm64 workspace image is
`sha256:0e35564b70f87800f99750bd5d3637d35cc5e910aadd17307763e59c1a89f4ff`,
tag `deskmates/workspace:arm64-b624560de4b7`. Offline app-layer build uses the same
cached base and Docker network none; aliases and stable services are untouched.

SHA-256 bindings:

| Artifact | SHA-256 |
| --- | --- |
| Tracker source | 6dc0a4d4a1d36355a5e6eed38fcd64aa357a789f1e386ad829dc8dc6c7fc9c87 |
| runOnce source | 4c96120123c4205bafde1824e3c03cc32d1451c58b7de1eb2064fa7426d56bb5 |
| Dispatched T2 source | 0acd5716ebd043e1ae7141309fbe6caf2ca42df0c714e4910cc9286f4341cef4 |
| Three-invocation independent audit | c9ea0c29868bc70e985b870a81fce73592ba9f948cd93c79d70670b2662515d5 |
| Proxy/turn oracle receipt | 0624eca481ffdce2181dc4e20dddb0464e7e5268b2c07eb7d58cc82b376e9e8c |
| Decision replay receipt | eec798b3c9a21952b703f9aa095b1e1a08caa8460a557b4485d96e9f03ee1065 |

The collector independently checks three closed ledgers (integrity/FK valid),
all three runner PIDs/process groups and all eighteen absent exact owned Docker
identities. All 983 inputs per invocation match at termination. Actual operator
GET receipts feed the repository's offline replay: one local Bash decision,
identical in all five compared policy dimensions, with no unsupported/error
result. Before/after recorded decisions and first upstream system hashes also
match. Initial missing eval path mapping and sandbox IPC preflights are retained;
neither starts an SDK/model attempt. No model behavioral distribution is inferred
from this one decision or a scripted trajectory.

## Remaining gates

The fresh 3530ec94 Testbox gate passes 2475 T0/T1 and 90 full T2 assertions,
zero failures and one real-model skip, on a separately built amd64 image.
Its selected offline replay passes after correcting an external .ts launcher;
the original failed stage remains retained, without an SDK or T2 retry. See
`m3-stream-usage-integrated-gate-results-2026-10-03.md`. The a786a38c gate remains
bound to the previous tracker image. This framework check is not configured-model
usage or token quality evidence. Null
cache reporting, actual context windows/resume prompt snapshots and compression/
retention quality still need the configured endpoint and ordered experiments.
Nested correlation is directly tested with SDK-shaped interleaving in unit tests;
this selected actual SDK task is a main-thread task, not a nested-agent trial.
The earlier screenshot failure is retained without a proven cause or fix.
Live WABA configuration and the broader model-campaign scope confirmation remain
pending. Full M3 is not accepted and no strategy setting is promoted.
