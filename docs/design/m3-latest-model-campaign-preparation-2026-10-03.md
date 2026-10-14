# Latest-candidate model campaign preparation

Date: 2026-10-03 (Asia/Taipei). Status: prepared locally, not authorized or
executed. No model configuration was read, no SDK query or real-model call
was made, and no new model service was dispatched on Testbox. M3 remains
incomplete. The owner's WABA account exists; its configuration is not ready.

## Candidate and unchanged proposed scope

The old prepared model runner binds the fcbd9e69 candidate and must not
silently serve as acceptance of the latest fixes. The replacement binds
the completed [42bab952 gate](m3-memory-integrated-gate-results-2026-10-03.md):
967 inventoried files, 2475 passing T0/T1 assertions and 91 passing T2
assertions with one opt-in real-model SDK-shape skip. The native systemd exit
status became unknown after unit garbage collection; the saved individual
command exits, test oracles and independent resource/ledger audits establish
the gate. No passing model result is inferred from that gate.

Candidate manifest:
`42bab952f411f34f993ee9d18ba2d74be6db482df2e13e1b2806d3c8fe4b748a`.
Source archive:
`e0a9ab986c78a40eba3db12ff5f2240b06dca8277a4272168a7c671fb5b778c6`.
Parent directory:
`/home/owner/agent_workspace/deskmates-reusable-memory-integrated-gate-20261003-42bab952`.

The proposed eighteen T3 files, 37 registered assertions and two context
observations retain the exact tasks and limits in the
[original scope table](m3-real-model-campaign-approval-scope-2026-10-02-fcbd9e69.md).
Read-only SSH comparison finds all 22 acceptance files unchanged between
those candidates; the preparation also verifies every selected file against
the latest frozen inventory and current local source. This is a source
comparison, not a test invocation. One invocation per suite/mode, one worker,
M2_REPETITIONS=1, owner-v1 and explicit-v1 remain fixed. No new approval
watcher, replacement task or automatic retry is introduced.

Active time remains 14370 seconds with up to 30 seconds termination grace,
giving a four-hour outer service ceiling. A T3 stage is bounded by 3600
seconds and the remaining campaign time. The T3 matrix still has **no
verified hard aggregate request, token or dollar ceiling**. Thirty-seven
assertions do not mean thirty-seven model calls. The separately inventoried
context modes retain their original 20-request SDK-resume and seven-request
window-cache bounds. SDK-shape is explicitly excluded with no enabling flag;
live WhatsApp remains a separate missing prerequisite. This proposal alone
does not cover all outstanding M3 memory, runtime and quality gates.

## Prepared runner and checks

Source: `spikes/m3-latest-model-preparation-20261003/model-only-runner.py`.
SHA256: `6f07da66c22119a85d5528e4ae54a38e1d676d8dde4b1c6a04cba5f54dd66062`.

Before reading model configuration, the runner checks the frozen inventory
and archive, exact completed gate receipts, 21 valid ledger audits, five
exact runtime image IDs and its three helper hashes. It reconstructs the
source in an exclusive owned directory and copies only the on-host tested
dependencies and compiled files. All 1708 compiled files must match the
candidate runtime manifest with SHA256
`c44bccfb3ab59c55d515d749b204f8778cd3cf983d79a976224911fa93bab1bc`.
No stop-stack overlay is needed: the frozen source already contains the
ledger-preservation helper. A domain fixture preflight must pass before
the same-user mode-0600 model bootstrap reads its four selected keys in
memory. That preflight has not been invoked as part of this preparation.

The context source keeps manifest
`3fb2b635ee4ec9abdb15c91f4fa273b31d51756ea15ab112b64bbed3fd4c936d`.
Its four inventoried files are hash-checked and copied into the new campaign's
owned context directory before invocation. Its old source, reports and
reservation are preserved. No context invocation/reservation was created
by the local preparation.

The accounting repair distinguishes actual configured proxy-request
observations, the injection corpus's explicitly synthetic sender, and
unattributed run rows. Missing usage stays unknown, including null token
fields. Recorded attempt IDs are evidence, not inferred physical SDK query
or billed request totals. Read-only ledger snapshots are deduplicated by
run ID using their newest backup. Inspection failures during exact-resource
cleanup remain unknown rather than being called absence; the shared
`deskmates-egress-outbound` network is excluded.

## Local regression evidence and retained failure

`work-self-check-01` passes the initial accounting and deadline fixtures.
Its tested source was reconstructed afterward with the original SHA verified;
it is not represented as having been copied before that check.
`work-self-check-02` copies its source before testing and intentionally removes
the plan to exercise startup failure. It then fails with FileNotFoundError
before its deadline child is invoked. That failure is retained; it makes no
SDK/model calls.

The final `work-self-check-03` copies the exact runner source before testing,
executes its actual accounting/save/stage function bodies with local fixtures,
and passes. Five SQLite fixture rows demonstrate that old accounting calls
all five real; corrected accounting identifies three proxy-observed rows,
one synthetic sender and one unknown. An unexpected proxy request on a sender
stays observed. Missing usage fields remain null and the original fixture
ledger hash is unchanged. Removing the plan now still saves a receipt,
marking scope unavailable and keeping four rows unattributed. Restoring the
plan restores the expected attribution.

The 0.25-second scaled deadline terminates and reaps its owned sleeping child
in 0.262 seconds, returns 124, independently verifies PID and process group
55832 absent, and prevents the next stage from starting. This verifies local
runner mechanics, not actual four-hour execution, remote cleanup, suite
completion or model quality. All three self-checks use zero SDK queries and
zero real-model calls. They never execute the runner's module-level dispatch
or read model configuration.

## Review bundle and execution boundary

`prepare.py` builds a local explicit-inventory bundle only. It verifies the
selected source/helper/runtime hashes and final self-check binding; its
archive contains seven files (including SHA256SUMS), no credentials, .env,
history or dependencies. The archive is 90031 bytes with SHA256
`2e1a3cab56dabc484bc6652090249040d6b5920219c28a7c7de45b5bcfba1538`.
Its extracted member bytes were independently checked against the inventory.
The bundle and receipt remain in
`spikes/m3-latest-model-preparation-20261003/work-bundle-01/`.

After explicit approval of this scope, the reviewable proposed dispatch is
to transfer that exact bundle into a fresh isolated
`/home/owner/agent_workspace/deskmates-reusable-m3-model-preparation-42bab952-20261003-01`
directory, verify its archive SHA and extracted SHA256SUMS, and use:

```sh
systemd-run --user \
  --unit=deskmates-m3-model-42bab952-20261003-01 \
  --property=RuntimeMaxSec=14370 --property=TimeoutStopSec=30 \
  --property=KillMode=control-group \
  python3 /home/owner/agent_workspace/deskmates-reusable-m3-model-preparation-42bab952-20261003-01/model-only-runner.py \
  /home/owner/agent_workspace/deskmates-reusable-m3-model-42bab952-20261003-01
```

These commands have **not** been executed. Existing automatic approval review
rejected the expanded model campaign because the earlier limited campaign
waiver did not authorize it; direct scope confirmation remains pending. A goal
continuation, preparation receipt or WABA account reply does not supply that
answer. No deployment, commit, tag, merge, prune, stable-service change or
prefix-based cleanup is part of this proposal.
