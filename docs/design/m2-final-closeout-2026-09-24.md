# M2 final closeout

Date: 2026-09-24
Status: integrated fixes; remaining acceptance failures retained; no deployment claim
Starting revision: `1270e05` on `codex/desktops-ui-20260923`

## Objective and boundaries

The product owner requested M2 closeout after the desktop and membership work.
Reconcile the earlier handoffs against the integrated code, repair demonstrated
remaining defects, and run the outstanding real-runtime acceptance gates. Existing
failed and interrupted runs remain evidence. Marketplace, templates, private-service
connectivity, database protocols and alternate providers remain outside this batch.

Use dedicated image tags, disposable workspaces, ephemeral listener ports and new
artifact directories. Do not restart the application or replace its database,
workspace or shared image tags. The current operator previews are separate fixtures.

## Closeout gate inventory

| Area | Latest evidence | Remaining boundary |
| --- | --- | --- |
| B1 messaging and B3 collaboration | r6 configured-model group, chief and X01 billing pass 1/1 each | Foundation finishes 7/8; second-round chief silently omits delegation |
| B2 browser/approval/takeover | Real browser/approval/snapshot T2 pass; r6 takeover T3 passes all 12 checks after SSE fixture auth repair | Retain the first fixture failure separately |
| X02/X03 concurrency | r4 X02 canonical fail; X03 canonical pass; both strict diagnostics fail | Fixed 300-second timeout and one incomplete write remain; K5 not expanded |
| B4 operator/workspace boundaries | r3 focused live matrix passes 5/5; r4 loopback correction passes targeted tests | Not the full deployment-hardening matrix or native Linux platform acceptance |
| B5 knowledge and memory | Real memory/knowledge T2 passes 4/4; r4 configured-model reviewed knowledge handoff passes | No retrieval quality improvement claim |
| Native execution | PTY T2 passes; r6 actual pinned CLI and automatic MCP fallback each pass | Optional strategy remains opt-in; no numerical safe-capacity claim |
| Visual model tasks | S09/S10 fail; PNG/JPEG transport passes; two direct upstream probes cannot read the image | Owner deferred visual-model integration/acceptance on 2026-09-24 |
| Operator UI | Existing desktop/membership implementation and 126 web tests retained | Current live app was not restarted/deployed by this closeout |

## Frozen first attempt

- Workspace image: `cogbot/workspace:m2-live-closeout-20260924-r1`
- Workspace image ID: `sha256:3362394081c4b47e529ba9c19fef54773dc3c797ec4f3d698034a836a506ec5b`
- Egress image: `cogbot/egress-proxy:m2-closeout-20260924-r1`
- Egress image ID: `sha256:9b046a953d0a336c88eb6d88500caeba462197307126fbdcaa0ff0cfbd3de95e`
- Model configuration: existing ignored environment; primary `glm-5.3`, cheap `glm5.3-flash`.
- Default browser strategies remain `tab-v1`, `explicit-v1`, `baseline-v1`.
- Evidence: `spikes/m2-closeout/work-20260924-r1/` (ignored raw output).

Run existing deterministic browser/approval/takeover checks before spending on model
runs. A failed smoke blocks K5 expansion until the first fault is understood. Never
increase task deadlines, replace a failed repetition or relax the expected-state
oracle to obtain a passing report. Optional strategy candidates require separate,
labelled evidence and the repository measurement protocol before default adoption.

## Results before host-routing correction

Three parallel subagents cover collaboration, workspace boundaries, and knowledge /
native execution. Integration uses dedicated images and leaves the deployed application
untouched.

- `r1` failed before a model call: npm had omitted the SDK's optional Linux ARM64
  native executable. The Dockerfile now installs the matching pinned package as a
  required dependency and executes its version command at build time.
- Workspace `r2`, ID `sha256:1e8fbf767d8653c5a38967e37902afeb23c60094a2b48e92b43583115664acc5`,
  starts the native SDK. Its three targeted image checks pass after correcting the
  new test to resolve the exported SDK entry point rather than its private manifest.
- M0 SDK smoke on `r2` failed (6 assertions, 1 passed): model requests and ledger
  callbacks cannot reach macOS through the internal bridge's `host.docker.internal`
  mapping. No real-model campaign was launched on this broken path.
- B4's initial `r1` fixture lacked the required view password; fixed in the fixture.
  The `r2` run passed sibling file/process/network separation. Both host reachability
  assertions failed. The egress case reached deny, allow, direct TCP/DNS deny and
  revoke checks before a proxy restart readiness race. The corrected restart check
  waits for a real response and still requires HTTP 403; HTTP 000 is never a pass.
- B5 real-image tests pass: 4/4 for unpublished drafts, 27-item pagination,
  publish/reject, immutable history, cleanup, MEMORY edit/export/clear/conflict,
  suggestion apply-once/reject and a new Gateway instance reading the persisted
  search index and versions.
- Native PTY real-image test passes: interactive input/incremental output, 64 KiB
  cap, dropped-output count, four-session limit, resize, Ctrl-C, deadline cleanup
  and attempt ownership. This is not proof of SDK approval/redaction hooks.
- Full T0/T1 initially had 1 failure / 1,318 passes: a fan-out fixture could reach
  relay cap before its expected turn-budget pause. Its budget is now explicitly
  four, making the intended budget branch deterministic without changing production
  limits. The target passed 20 repetitions, its file passed 9/9, and the subsequent
  full suite passed 1,319/1,319 across 118 files.
- Shared SSE acceptance clients now authenticate and fail on non-2xx responses.
  The browser driver requests takeover through phase files; the authenticated
  operator calls remain on the host, and no operator token is sent into a workspace.

The owner approved the host-proxy mechanism on 2026-09-24. ADR-0009 records its
constraints and verification requirements. Implementation and fresh acceptance are
in progress; prior passes above are scoped to their actual image and mechanism.

## Audit of independent ticket K5 evidence

The collaboration subagent audited the completed remote campaign at
`/home/owner/agent_workspace/deskmates-b1b3/spikes/m2-business/work-k5-20260923T122324Z/ticket-k5`.
It used source `cbac38f2fe515686e15971870c722620b312942c`, image ID `sha256:d494d208…`,
GLM 5.3, role v2, tab-v1 and inline-v2. All 40 runs succeeded; X02 and X03 canonical
state checks each passed 5/5. X02 strict diagnostics passed 5/5; X03 passed 3/5
(one Bash no-op and one unavailable thread_post call). No repetitions or controls
were omitted. This is functional evidence for that exact configuration, not strict
K5 or acceptance of the current desktop image / explicit-v1 default. The image ID
also differs from the prior handoff's recorded ID.

## Integrated runtime and model progress

Infrastructure implementation: `1cee835`; acceptance fixtures: `3673944`;
IPv6 loopback correction: `d44c796`.

- r3 workspace: `sha256:a70b07d43205a265697c9f5f9f6964e4a318f018483f9841096aadb4f17a46e8`.
  r3 proxy: `sha256:0a2b9a1177f2bd3aa92aa930513a8fd62fb8cfb34177478436be280ad9805ccf`.
- r3 M0 real SDK with scripted upstream: 7/7 pass; the run completes in roughly two
  seconds with model proxy, ledger, reply, usage and credential-path assertions.
- r3 focused B4 live matrix: 5/5 pass. Split listeners, proxied host exception,
  sibling separation, ordinary public egress and restart denial work. An in-flight
  host response survives public allowlist revocation. This is not the entire B4
  handoff matrix. The result at `work-b4-r3/RESULTS.md` is explicitly transcribed
  terminal output, not a captured raw log.
- r3 browser batch: 8/9 pass initially; all browser, takeover, approval, snapshot
  and silence checks pass. The failed loop-budget case accumulated eight active
  bots across two cases in a six-screen workspace. After separating those cases'
  workspace lifecycles, both group-limit tests pass (2/2). No production cap or
  oracle changed. Raw logs are under `work-20260924-browser-r3/`.
- The browser driver verifies shared login, stable targets, sixteen concurrent
  clicks and sixteen correctly attributed captures (`counters: [8,8]`,
  `clickCaptures: [8,8]`).
- The model foundation fixture had the same cross-case accumulation issue; it now
  starts a workspace per case. Prompts, bot composition, deadlines and assertions
  are unchanged. Its model campaign remains pending.
- Full offline regression after proxy integration: 1,331/1,331, 120 files. Subsequent
  IPv6 correction passed 107 affected tests and typecheck; lint passes.

The final r4 images add a correctly bracketed `[::1]` bypass, verified with a real
IPv6 loopback listener, and contain formatted proxy source with identical behavior:

- Workspace `cogbot/workspace:m2-live-closeout-20260924-r4`:
  `sha256:be3e8f675d3e876cb8d768cf63674ee18ccde54edebed833a9fc17e18cff5e21`.
- Proxy `cogbot/egress-proxy:m2-closeout-20260924-r4`:
  `sha256:b23093917a36dae8faaf5a041ed691f02216b8ea0ec086bc5f3f3423c0353499`.

Configured-model knowledge acceptance passes on r4 with `glm-5.3`, default
`explicit-v1`, and no prompt/oracle/deadline changes. Writer
`run_6fc9d1a4540c4e2280e38f67587c8dc0` proposes a draft; the operator publishes
`kb_31684c76d4e6408fb0e58560f3d210bc` version 1; reader
`run_8f7c2a53eeec4301af011d472f05d460` searches and reads that exact document.
Both runs succeed. `work-knowledge-r4-20260924/` contains the manifest, log and
full structured evidence, checked for absence of the actual upstream token.

The r4 ticket smoke completed with X02 canonical failure and X03 canonical pass;
strict diagnostics failed in both scenarios. The incomplete X02 write and timeout
are retained. See `m2-model-closeout-results-2026-09-24.md` for full run IDs and
final artifacts. The earlier remote K5 is not a pass for this configuration.

## Visual and CLI coverage audit

Development continued in a separate worktree, `codex/m2-vision-closeout-20260924`,
from `d44c796`, keeping the running r4 ticket campaign's source and golden-site
fixtures unchanged.

- The pinned MCP click schema uses `target`, with optional `element`. The vision
  tracker required the obsolete `ref` shape, so real pinned calls could never
  trigger its automatic screenshot. Commit `1989c86` accepts exact pinned target
  errors and preserves the two-miss / observation-refresh behavior. It does not
  enable the opt-in execution strategy by default or retry the failed action.
- Governed CLI origin validation rejected `host.docker.internal`, contradicting
  approved ADR-0009. It now accepts that exact infrastructure name, still requires
  its live allowlist entry, and rejects internal lookalikes, IPs and malformed
  origins. Real CLI attach/receipt/screenshot/detach and real MCP fallback T2
  gates are added; their Docker execution is pending.
- `/shadow` and `/canvas` were authenticated stub routes. Commit `f52a5b7` adds
  the canonical S09/S10 fixtures, resettable state and operation logs, and bumps
  the golden-site/task-set site version to 1.2.2. The new configured-model T3
  requires a successful screenshot call before coordinate interaction, expected
  state and answer, and no shell/DOM/API bypass. Autonomous visual completion
  and the opt-in automatic fallback are reported separately. Neither proves
  default automatic fallback adoption.
- Offline regression on the new worktree: 1,344/1,344 tests across 120 files,
  typecheck and full Biome check pass. CLI origin tests pass 17/17. No Docker or
  model result for these new changes is claimed yet.

The r4 ticket campaign has one retained first fault: run `run_c723d3f2` reached
the unchanged 300-second run limit after the first three runs succeeded. Its
12 browser calls have no error tool results, missing-target errors or repeated
login/tab switching. Thirteen completed model-request spans recorded 313.7 seconds
of time-to-first-byte in aggregate, versus 2.2 seconds across browser RPC spans;
these spans may overlap and are not an additive wall-clock decomposition. The
evidence points to model execution/latency within the fixed window, not a
demonstrated browser-framework lookup defect. The final artifact confirms that ticket 1058 remained without its refund tag;
X02 fails both runtime and requested writes. No retry or K5 expansion was launched.

## Native browser execution results and integration

The visual and CLI work was integrated into `codex/desktops-ui-20260923` as
`d897823`, `35063af`, `917d6f3` and `46bd139`. The corresponding source commits
on the isolated development branch are `f52a5b7`, `1989c86`, `b05d390` and
`c59414c`. Runtime sources match; commit IDs differ because of cherry-picking.

- r5 image `sha256:82b28e64ab0742daceb3ef37b51dc82f27939877a258e83b27344d568c642efb`
  exposed a native CLI defect: pinned `run-code` has no global `URL`, so the
  generated origin fence threw before the requested fill. Native attach and raw
  JSON receipts themselves worked. The original failure and read-only diagnosis
  are retained under the isolated worktree's `work-vision-r5-20260924/`.
- The generated workflow and capture now read `location.origin` in the page
  context, retaining exact CDP target and expected-origin checks. A VM test without
  global `URL` executes both generated programs. This is a runtime repair, not a
  new model strategy or a relaxed completion fence.
- The vision T2 initially failed during setup because its test passwords did not
  match the image's required control/view formats, then because it used a numeric
  loopback URL outside the browser resolver's explicit `localhost` bypass. These
  fixture errors were corrected, with all setup-failure logs retained; no product
  auth or egress policy was weakened.
- r6 workspace `cogbot/workspace:m2-live-closeout-20260924-r6`, built from
  `b05d390`, has image ID
  `sha256:3fafe3b94ec9cd6b160ac03318e05b66a721c3135fa4a62cd84c57a33400f4d0`.
  It uses the unchanged r4 egress image.
- Real pinned MCP T2 passes 1/1: stale target, refreshed snapshot, repeated stale
  target returns a fresh JPEG with the automatic fallback diagnostic. The failed
  action is not retried and the page remains unchanged. This directly invokes
  the opt-in proxy feature; it is not default-strategy or model completion proof.
- Real pinned CLI T2 passes 1/1: exact run tab receives the fill, its peer stays
  unchanged, final JPEG attribution matches the run target, and both original MCP
  connections remain usable after CLI detach. No mocked CLI invocation is used.
- Final offline regression: 1,345/1,345 across 120 files; typecheck passes. Raw r6
  build/T2/unit logs are under the isolated worktree's
  `spikes/m2-closeout/work-vision-r6-20260924/`.

Configured-model group and chief gates both passed their first samples on r6.
Existing application containers and host ports were not restarted or replaced.
The isolated r5/r6 raw evidence directories were also copied into this primary
worktree without overwriting any prior evidence.

## Final configured-model and transport observations

- `work-group-r6-20260924/`: group T3 passes 1/1 (64.56 seconds), including
  parallel mentions, ordered silent observation, nonmember join and history.
- `work-chief-r6-20260924/`: chief T3 passes 1/1 (31.78 seconds), including both
  expert delegations, result collection and one final aggregate.
- `work-takeover-r6-20260924/`: the first T3 fails waiting for SSE handback.
  Its collector sent no operator credential and did not reject HTTP 401; the
  ledger already recorded taken/handed_back and MFA succeeded. Adding host-side
  Authorization and an HTTP-status check repairs this fixture. No token enters
  the workspace, no production source changes, and the ten-second event deadline
  is unchanged. `work-takeover-r6-authfix-20260924/` passes 1/1, all 12 oracle
  checks true, with both runs succeeded and 285 SSE frames. Both samples remain.
- S09/S10 first samples in `work-vision-model-r6-20260924/` fail. S09 terminates
  succeeded but leaves approval false, makes a forbidden Bash call and never
  clicks coordinates. S10 leaves the chart at 41 and reaches the 20-turn limit
  after screenshot/Read/Bash activity, also without a coordinate click. The ledger
  screenshots visibly contain the Approve and Refresh controls; the fixtures are
  not blank. These failed samples were not rerun or excluded from the historical
  report.
- A no-model real MCP/SDK/Gateway transport T2 passes for both the exact default
  `{scale:"css"}` PNG call and explicit JPEG. Each image appears in the immediately
  following upstream request, matched by its own tool-use ID, with valid signature
  and nonempty decoded bytes (PNG 14,106; JPEG 17,713). This rules out loss of the
  screenshot by the tested Deskmates transport. The raw log is
  `work-vision-transport-png-jpeg-r6-20260924/test.log`; the earlier JPEG-only
  result remains separately labeled as transcribed output.
- One direct image-input diagnostic per route sends the same synthetic chart JPEG
  and prompt to `glm-5.3` and catalog route `openai/Qwen3.8-27B`. Both return HTTP
  200 and text saying they cannot see an image. The Gateway repository forwards
  bodies unchanged. These observations indicate ineffective image input in the
  configured upstream/model path, but do not establish exactly where that external
  path loses or ignores images. They are capability diagnostics, not agent-task
  passes or a statistically meaningful model comparison. Default configuration
  was not changed.

On 2026-09-24, the owner explicitly said to ignore this visual-model issue for
now. Visual-model integration and visual T3 acceptance are therefore **deferred
by the owner**, not passed. The actual MCP automatic fallback, native CLI and
image transport remain verified. No further model routes were tried.

Commit `b7a1d39` records the T3 SSE fixture correction, image transport regression
and bounded diagnostic script. The B1 foundation gate completed its
original two repetitions: 7/8 passed, with the second-round chief failing. The current-default X02 failure and unrun K5 remain
open independently of the visual deferral. Private protocols, full B4 deployment
hardening, overnight/capacity claims and strategy adoption are not established
by this focused closeout.

The 34 newly collected group/chief/takeover/visual artifact files were checked for
the actual upstream auth token without printing it; there were zero matches.

## Foundation repetition result

`work-foundation-r6-20260924/` records the original two repetitions, eight cases,
and 180-second / eight-turn limits. Seven cases pass; `chief2` fails. Its only run,
`run_beac881caf0742f8be2dabdc14870b1d`, receives the intact human delegation
instruction but ends `silent` with no tool calls, so neither expert is woken.
No warning/error ledger event or browser action explains it. The first-round
chief case passes with the same fixture contract. The evidence does not establish
a scheduler or message-delivery defect, and the failed case was not rerun or
rewritten to obtain a pass. Other cases verify ordered silence, concurrent
mentions and real `message_bot` background handoff in both rounds.

The foundation runner now records both image IDs and working-tree status and
retains raw stdout/stderr as `test.log`. This is evidence bookkeeping, not a
change to cases, prompts, deadlines or oracles. The billing gate is recorded separately below.

## Billing result and final scope

`work-billing-r6-20260924/` passes X01 on its first r6/GLM 5.3 sample (357.37
seconds for the test file, with unchanged per-run limits). The final report
contains six runs, four bot messages, no thread pause and no turn-budget breach.
Strict assignment/result protocol conformance is true: one chief assignment, one
report from each expert, and a final chief aggregate. The initial browser discovery
sees every expected ticket, the date and billing label; business-state and
unrelated-state oracles pass.

All engineering corrections described above are committed to the isolated M2
integration branch. The currently running application was not deployed or
restarted. The runtime image remains r6 with r4 egress; later changes are tests,
runner evidence handling, operational notes and this report.

**M2 is not marked fully accepted.** Two retained nonvisual failures remain: X02
concurrent task 0 exceeds 300 seconds with ticket 1058 unmodified, and foundation
`chief2` ends silently without delegation. The broader ticket strict diagnostics
also remain recorded. A new strategy/model claim needs the existing measurement
protocol; neither more permissive oracles nor replacement samples were used.
K5 expansion remains withheld after the failed smoke. Visual-model acceptance is
separately deferred by the product owner, not silently counted as a pass.
