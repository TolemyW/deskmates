# M3 repaired candidate regression — 2026-10-02, 5b75f541

The production shutdown repair was integrated into a new full source freeze,
including task-related dirty changes. The no-model regression is finished,
but the candidate did not pass all deterministic gates. Neither the earlier
`fcbd9e69` pass nor the separate screenshot observation replaces this result.

## Binding and execution

- HEAD: `1109ec784d6493b39ccfbde605484f4feef6bc98`; 939 inventoried files.
- Source manifest SHA256:
  `5b75f5414c8688b705b0f9a80877f9b0e579e35ca243bb902d382cfa4e6d53fb`.
- Source archive SHA256:
  `dfb98a18b71da1aafb7c7c68839fb51fa7e4e0b49bc7c4b8957e7841a919c412`.
- Helper archive SHA256:
  `b6173498133213c4df780c9c0d7730bfacc7ae593e92ea5009c9a0dae234ee9c`.
- Campaign:
  `/home/owner/agent_workspace/deskmates-reusable-m3-candidate-20261002-5b75f541`.
- Unit: `deskmates-m3-deterministic-20261002-5b75f541.service`;
  invocation `57c9ea9c049049808fbf41c0fe9269d2`, now inactive/dead, MainPID 0.

The persistent controller held the host test lock, with a one-hour service
limit and exact-ID cleanup. All 939 original hashes were verified before
execution, after build, and after tests. Its disclosed ledger-preservation
overlay retains the original stop-stack source for those checks. Credentials,
`.git` history, workstation dependencies and unrelated data were excluded.
No commit, tag, merge or deployment occurred.

The workspace image was built through the normal production Dockerfile:
`sha256:c25d2707784381921e11569364770e132e7272baeb0bb3ca8d309b7a631f1061`,
tag `deskmates/workspace:amd64-24a81b58c7f2`. This is a separate full-candidate
image from the focused shutdown receipt's `946e9263` image.
The existing egress, golden-site and connector images were reused only after
source, package/lock and applicable compiled-input hash equality checks;
`evidence/component-reuse-binding.json` records that binding. Final domain
and full T2 checks used these selected image IDs directly.

## Gates and retained failures

Backend/web typecheck, lint, backend/web build, offline dependencies,
supplemental regression (8 assertions), populated migration/CLI, workspace
image build, public egress, default-user connector import, and the fresh
no-model domain preflight passed.

| Gate | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Full remote T0/T1 | 2447 | 1 | 0 |
| Full remote T2 | 86 | 1 | 1 |
| Workspace image cases within that T2 run | 15 | 0 | 0 |

T0/T1 failed in `scripts/scenarios/gateway-roundtrip.test.ts`: it compared
the exported chat list directly with declaration order. Thread and bot lists
use `ORDER BY created_at, id`; same-millisecond creation can change that
order. ADR-0005 requires member join order, not scenario declaration order
for separate chats. The local correction forces reverse chat timestamps,
compares title/member content by title, retains ordered member arrays, and
compares complete bot configurations by name. Production ordering is unchanged.
The corrected test hash is
`de1ba07c4fbe77d59e48769855d81425eef1af4db751a339aa5713e1b44d64fb`.
All 14 scenario tests, the scenario TypeScript check and file lint pass.
The corrected local full T0/T1 run passes 2448/2448 with zero skips, using
the required loopback-listener permission. The correction is outside the
immutable remote `5b75f541` source and does not rewrite its failed receipt.

Full T2 failed in the first `acceptance/m2-browser.container.test.ts` case:
two screenshot RPCs exceeded the unchanged 5000 ms bound, and a click's
capture marker was skipped. The driver preserved counters and captured the
failure rather than ignoring it. This resembles the retained `38bc790f`
observation, but neither an exact root cause nor a shutdown-related regression
has been demonstrated. The one T2 skip remains the opt-in real SDK-shape
check. It was not called through the deterministic runner.

## Separate screenshot observation

One predeclared, no-model diagnostic used the same 939-file candidate and
selected image IDs in
`/home/owner/agent_workspace/deskmates-reusable-capture-diagnostic-20261002-5b75f541-01`.
Unit `deskmates-capture-diagnostic-20261002-5b75f541-01.service`, invocation
`4dafc7d40b5440f7aacd12a6e53be2a5`, ran 14:18:00–14:19:33 UTC and is
inactive/dead, MainPID 0. Helper archive SHA256:
`4b8d01a7fcc9375d00132ba489bff6d4b7e1ca1af50f391d7aeace5cfaf900bd`.

Test-only overlays enabled existing attempt-one phase timing and retained
sanitized driver output, capture metadata and read-only CDP visibility/focus
observations. Original/overlay hashes are explicit. There was no production
change, increased timeout or artificial delay. The same two clients performed
eight concurrent ordinary-click rounds. The selected assertion passed; the
other two assertions were filtered out, not accepted by this observation.
Counters and valid own-target captures were both `[8,8]`. All 16 click captures
had JPEG bytes, the correct target and no skipped marker. The only two skipped
markers were the intentional human-takeover and peer-tab contention controls.

| Click phase | Count | Minimum ms | Maximum ms |
| --- | ---: | ---: | ---: |
| browser before | 16 | 1036.04 | 1050.17 |
| browser RPC | 16 | 541.18 | 565.90 |
| browser after | 16 | 518.75 | 533.58 |
| capture RPC | 16 | 34.51 | 65.96 |
| capture overall | 16 | 2139.71 | 2184.41 |

All 17 read-only CDP observations succeeded, taking at most 26.72 ms overall.
The observer may perturb timing. A pass in isolation does not establish the
cause of a full-suite timeout, a reliability improvement or a passing full T2
gate. No result-selecting additional observation was invoked.

## Accounting, cleanup and outstanding acceptance

Real-model calls and real logical run rows are zero. The full deterministic
receipt contains 50 fake logical run rows; their usage is separate from real
model accounting. The screenshot observation made zero fake-upstream requests
as well as zero real-model calls. Neither runner read a model credential file.

Independent inspections confirmed all 187 exact full-regression resource IDs
and all six diagnostic resource IDs absent. Inspection errors are not assumed
to mean absence. Stable deployment resources were preserved; no name-prefix
cleanup or image/cache pruning occurred.

Raw source, identity, transfer and downloaded receipts are retained locally in
`spikes/m3-closeout-20261002/work-local/candidate-shutdown-full-01/` and
`spikes/m3-closeout-20261002/work-local/capture-5b75f541-01/`; the corrected
full local unit report is `work-local/shutdown-order-corrected-t01.json`.
Remote raw evidence and SQLite ledgers remain in their isolated campaign roots.

The broad eighteen-suite/two-context-probe model campaign remains uninvoked:
automatic approval rejected the prior authorization scope and the concrete
human approval request remains unanswered. The WhatsApp account exists but
its runtime configuration is not prepared. Live channel acceptance, real-model
domain/SDK checks, memory paired evidence and the unresolved full-T2 capture
failure still prevent M3 closeout. No new strategy knob has been adopted.
