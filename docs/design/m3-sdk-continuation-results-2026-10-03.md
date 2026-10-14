# Actual SDK continuation and Gateway process restart

Date: 2026-10-03 (Asia/Taipei). Selected UX-02 mechanics pass. Full M3 remains
incomplete. This is a local Colima check with the actual production Gateway,
DockerProvider, workspace sidecar and SDK 0.3.278, using a scripted localhost
Anthropic-protocol fixture. Real model calls: zero. No production code, stable
service, release, commit or deployment changes were made.

## Declared scope and outcome

Exactly one bounded invocation reserved three task posts in three separate
one-member threads. It ran six actual SDK physical attempts, with a one-turn
budget and 120-second per-attempt deadline. The enclosing deadline was 720
seconds; elapsed time was 15.67 seconds, exit zero. No retries were submitted.
The frozen compiled Gateway is used consistently with its test helpers;
source and compiled backend/image inputs match the earlier current-image receipt.

| Case | Actual outcome | Independent facts |
| --- | --- | --- |
| Continue after crash | Attempt 1 executes an owned local Bash write, exhausts its turn, writes a handoff and parks. The exact owned Gateway PID is SIGKILLed after that sidecar completes. A new Gateway process opens the same SQLite database and attaches the existing container. Operator continue finishes attempt 2 | Same run ID and SDK session across restart; same handoff bytes; pending decision survives; startup dispatches no new sidecar; resumed context contains the previous tool result and budget warning; progress file contains exactly one write |
| Stop | Attempt 1 executes the local fixture tool and parks; operator stop makes the run stopped with its handoff in the summary | Still attempt 1; no resumed SDK attempt; pending decision consumed |
| Continue limit | Attempt 1 parks; two explicit continues create attempts 2 and 3; third exhaustion fails with `turn budget exhausted after two continuations` | Same run/session throughout; continuation count exactly two; append file contains exactly three lines; extra continue is HTTP 409; no fourth SDK attempt |

The actual `PostToolUse` budget warning is visible in resumed upstream context.
The continued run delivers one bot reply. Only the original three human task
messages exist; all nine system notices have relay count zero. Continuation is
not a duplicate task submission. There are no pending approvals at termination.

| Logical run | Final state | Attempts | SDK session |
| --- | --- | --- | --- |
| `run_c9118cc847d94b5187922cb0d42f8337` | succeeded | 2 | `39497a7d-c9f9-4a1a-9e9c-b370e15a4dbf` |
| `run_d54e0e72f67a435283aa36f9ff2e1bce` | stopped | 1 | `d6966a6d-b8b8-4604-a02e-0ff4c9c4824c` |
| `run_4f94eb1b774b40eaa7fd78332ef701b5` | failed at declared limit | 3 | `8a9c9d1e-88ac-430f-b02c-31fd8dc3ffa4` |

## Accounting and terminal checks

All six physical attempts have both a model-request row and a matching run-usage
row. Session aggregates exactly equal their attempt sums. Scripted synthetic
usage is input **101522**, output **152**, cache read/create **0/0**; all costs
are null. These fixture counts are not vendor billing or model quality evidence.
SQLite integrity is `ok`, foreign-key violations zero. The receipt preserves
all run events and request/usage rows, including the expected cap failure.

The parent PID 48826 is gone; Gateway PID 48831 exits by SIGKILL and the restarted
PID 48896 closes normally. All four owned listeners refuse connections. Exact
ownership-journal cleanup and an independent second inspection confirm absence
of two owned containers, one network and three volumes. Shared outbound network
and unrelated resources are untouched. There is no active fixture job.

## Source, image and receipt binding

Work directory: `spikes/m3-sdk-continuation-20261003/work-01/` (ignored).
Its runtime inventory binds **983** source/compiled/config/helper inputs,
including 64 unchanged parent support/config inputs. All 983 match at invocation
termination. Workspace image ARM64:
`sha256:7e76493462b0f9a8484ae421a0a8dbf2ecb23e71a00deefefab447c5232c6bfc`.
Egress image ARM64:
`sha256:625ee0e145b3299366d8fc7ff45bf95853d806ab8f39f2e5d4d66b3d123a319f`.
Both are inspected before dispatch; no dependency download or image rebuild.

| Material | SHA-256 |
| --- | --- |
| Dispatched child, frozen verbatim in work directory | `59d895eb37e318eb14c232ad5803f86bb1cf43703b8bb7bd5a8d42735e171337` |
| Parent probe | `d45a5cdf2ccf7e9178b06f35424742a1ede710fc46edf0920c099e9b11d61ba7` |
| Bounded runner | `98adb06a0de479d9b54fe7a52e450786457af6bd4dfb62935554b1f929d7f40a` |
| Inventory | `e8168e0c2969a9229ce04f8f6cbc9b8ac6bd9e943ae58f5c93b40365b072a81a` |
| Closed SQLite ledger | `e787c0df2d59dfdd7069676bbeaf8ebaff351ad644ecd51388c5f1adb3bc4dcb` |
| Parent receipt | `13ee3839c7ba26cb9b0b8f8eb71e2b9f0aa1ad79f588440db5340c8414dbec27` |
| Upstream context proof | `c79d6f1cdd76c88636ccc32c2783ff2adc70b8f5e0a68eb45369fbfba1d72d68` |
| Independent verification | `1e391527a0b99cc7a719a9cebb92c96c5dde75b8e970e19ddf37f5c2658c60cb` |
| Persisted handoff read before and after restart | `02ade4b453600c0236d953ac6f8a6bda4584a4a396e41d7390e6509a0284fe9c` |

The standalone strict probe typecheck passed before dispatch. Adding repository
indexed-access/exact-optional checks afterward identified only fixture input
narrowing errors. The retained log records them. Empty defaults for already
validated argv/image values now pass those stronger checks; current child SHA
is `0cb1938eb7fdc4c5340f202539601ba7fd616feae68b04a378e9c3caba9ed492`.
The collector verifies exactly that small diff against the frozen dispatched
child and the other 982 unchanged inputs. The later child was not redispatched;
the receipt is explicitly bound to the original executed source. No runtime
production repair or result-selecting rerun is claimed.

## Limits

This proves the selected actual SDK/container/process protocol with scripted
responses. It does not prove configured-model task delivery, delegator quality,
24-hour expiry, interruption during an active SDK tool, automatic compaction,
full scoped memory protocol or powered strategy improvement. The handoff is
host-authored fallback text, not measured model-authored handoff quality.
One-member threads do not test chief/group routing. The configured-model campaign
still awaits its requested scope confirmation; live WhatsApp requires prepared
WABA configuration. The separate browser download landing remains unknown.
Existing T0/T1 and frozen full T2 counts are unchanged; this spike is not a new
full-suite run and does not close M3.
