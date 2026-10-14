# Current integrated M3 deterministic regression — 2026-10-03

Result: the separately frozen current working tree passes the deterministic
integration gate. Full M3 acceptance remains incomplete. No commit, tag, merge
or deployment was performed; Testbox stable services were untouched.

## Source and dispatch binding

HEAD `1109ec784d6493b39ccfbde605484f4feef6bc98` plus explicit dirty inventory: 950 files.
Source manifest SHA-256 `17cc11577dfbc18518e9de3c606fd33727dcd65b4b3378d1b5583885058cdacd`.
Source archive SHA-256 `a82c722b42a68586c627ebc93f1694ce39bb8410156f58d63d3bbe048a213f69`.
Transfer archive SHA-256 `4f004c365400897bf338e5e5010732d52845ef36d503b1997fda2981294c2758`.

Remote root:
`/home/owner/agent_workspace/deskmates-reusable-current-gate-20261003-17cc1157`.
Detached unit `deskmates-current-gate-20261003-17cc1157.service`, invocation
`85852758c69742188be25f5a7ac573ad`. The shared heavy-test lock was held.
Credentials, secret-bearing env files, keys, Git history and dependencies were
excluded from the transfer; dependencies were copied on-host. The runner
removed model credentials/configuration and never read a model env file.

## Gates and actual coverage

| Gate | Result |
| --- | --- |
| Backend plus acceptance typecheck | pass |
| Web typecheck | pass |
| Lint | pass |
| Full T0/T1 | 2458 pass, zero fail/skip |
| All workspace builds | pass |
| Full T2, exactly one invocation, two workers | 88 pass, zero fail, one skip; exit 0 |
| Stack ledger backups | 18 expected, 18 saved, 18 independently readable/integrity-ok |
| Source verification after build, after tests, independent terminal audit | 950 matching files, zero mismatches |
| Exact resource cleanup audit | 172 owned identities independently absent |
| Detached process termination | inactive/dead, MainPID 0, ExecMainStatus 0 |

T2 ran for 347.31 seconds. The sole skip is the opt-in real-model SDK call-shape
case; its absence remains explicit and is not counted as a pass. The scripted
upstream suites use real Docker, Chromium/MCP, SDK and Gateway mechanics but
do not establish configured-model task ability. No real model calls occurred.

The current browser runtime test made all 16 ordinary concurrent click calls,
produced exact counters `[8, 8]` and captures `[8, 8]`, and passed takeover,
handback, target restoration and peer usability. All 15 workspace-image tests
and both canonical-restoration tests passed. The frozen source includes the
cost-alert response-order and schedule display repairs, their T0/T1 regressions,
the canonical peer/manual-memory extension and current ledger preservation.

No capture tracing, DEBUG, experimental browser flag, driver override,
changed timeout, altered click oracle or result-selecting repeat was used.
Two Node preloads only recorded exact owned Docker resource identities for
cleanup; this bookkeeping is disclosed rather than presented as zero
instrumentation. Production capture still has its five-second bound.

## Image, ledger and receipt binding

The workspace image is `sha256:c25d2707784381921e11569364770e132e7272baeb0bb3ca8d309b7a631f1061`. Other exact image IDs are in
`work-01/receipt/evidence/images.json`. Reuse requires unchanged relevant
runtime source hashes (216 files) and independently rebuilt,
byte-identical contracts, sidecar, connector and golden-site compiled inputs.
The tests execute the newly built current host Gateway/Web/packages with those
verified unchanged runtime images; no stale compiled source was silently used.

The 18 preserved ledgers contain 56 run rows: 27 succeeded, 16 silent,
10 cancelled, 2 failed and 1 queued. These include intentional fixture
outcomes; a green test assertion is not equivalent to every run succeeding.
There are 44 synthetic usage rows; those are not actual model spending.
The queued fixture row is not an active remote process. Raw ledgers stay on
Testbox and are not downloaded. Independent audit records each ledger hash,
status counts and SQLite integrity check.

Selected receipt archive SHA-256:
`ca92992ad3f01edac4fe9e1c60b3481174c60459fd803d2c2c6740d9474cc761`.
Thirteen selected files are downloaded to
`spikes/m3-current-gate-20261003/work-01/receipt/`, each verified against its
selected inventory. Raw failed historical candidates remain untouched.

## Limits and remaining acceptance

This pass closes the current frozen deterministic integration gate. It does
not identify or repair the intermittent screenshot timeout: the previous
failed full observation and its 6.658-second CDP response remain evidence of
an unresolved reliability issue. No additional full run is selected to erase
that failure, and no experimental flag was adopted based on nondiscriminatory
mechanism probes.

The larger real-model campaign remains unlaunched after automatic approval
review rejected its scope; the earlier limited waiver does not authorize this
new campaign and the explicit scope question remains unanswered. WhatsApp
is not deferred: the owner has a WABA account but configuration is not ready,
so no real inbound/reply/approval/delivery journey has been accepted. Context,
memory/strategy and adopted operator journeys retain the precise outstanding
requirements in `m3-closeout-evidence-matrix-2026-10-03.md`.
