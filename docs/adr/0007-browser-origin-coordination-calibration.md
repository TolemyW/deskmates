# ADR-0007: Escalate browser concurrency to an origin-coordination prototype

Date: 2026-09-23
Status: Accepted
Scope: opt-in prototype authorized on 2026-09-23; production adoption remains gated
Source: ADR-0004 decision 6 calibration rule; B3 completion follow-up

## Context

ADR-0004 explicitly requires a new per-origin-lock ADR when measured interference
exceeds 5% over X02 + X03 at K=5. The completed summary-protocol C matrix has ten
classified pairs: nine clean and one concurrent runtime failure, with both matching
solo controls passing. Observed interference is **1/10 = 10%**. The Wilson 95%
interval is approximately 1.79–40.42%, assuming independent pairs; this small
sample does not establish a population bound. The prescribed empirical trigger
nevertheless fires. The earlier parser-only B matrix also has 1/10 failures.
Do not pool versions, drop the failed repetition, raise its timeout retrospectively,
or re-run until ten green pairs replace it.

In C repetition 5, X02 run `run_b8ee96ec1ab949f79dd62ee646cddd71` was killed by
its unchanged 300-second deadline. Its requested writes and unrelated-state,
target, screenshot-attribution, overlap and own-tab-wait checks passed; runtime
completion did not. The model kept inspecting extra ticket comments after the
requested labels had been written. Its trace includes a stale reference and
missing-capture warnings. No wrong-tab operation, own-tab lock wait or lost update
was demonstrated. Host/model-service contention and model over-verification
remain possible contributors. The escalation metric is operational, not proof
that the current lock implementation caused the timeout or that an origin queue
will fix it.

The full evidence and limitations are in
[the B3 results](../design/m2-b3-completion-results-2026-09-23.md). Group, chief,
X01, caps and takeover gates pass; B3's B2 concurrency dependency remains open.

## Decision

1. **Prototype origin coordination before declaring the concurrency gate closed.**
   Retain lock v1 as the recorded baseline and add a separately configured candidate.
   An origin is a scheduling key within one workspace, never a bot permission or
   credential boundary. Per-run tabs, shared login/files and workspace-wide human
   takeover remain. Do not enable the candidate in the main application as part of
   this evidence-only escalation.

2. **Coordinate browser work fairly by `(workspace, origin)`.** Same-origin runs
   queue; independent origins may proceed, subject to the existing target,
   focus and capture fences. Takeover excludes all origins. The runtime,
   not model-authored arguments, derives the effective origin from navigation and
   the recorded target. Cancellation, lease expiry, approval parking and run end
   release ownership. Origin changes must avoid holding one origin while waiting
   for a second; cross-origin redirects and resumed actions require explicit cases.
   This changes v1's own-tab-never-waits contract and therefore needs a versioned
   contract and oracle, not a silent change to existing tests.

3. **Waiting must not become a model polling loop.** The prototype needs an explicit
   Gateway/sidecar waiting/resumption contract, traceable wait duration and deadlines.
   Choose and document how queued time interacts with the existing 300-second
   execution limit before coding that behavior. Preserve an end-to-end latency
   metric so excluding queue time cannot manufacture apparent reliability. SDK
   session resume, tabs, approvals and takeover must remain recoverable. A larger
   timeout or more model turns alone is not the proposed fix.

4. **Adoption requires a new isolated comparison and complete regression evidence.**
   Run original solo/concurrent X02/X03 K5 under each candidate with the same model,
   task inputs, fixture and business-state oracles; record both the original v1
   wait oracle and the explicitly versioned v2 expected-wait oracle. Retain all
   original B/C failures. Report task completion, interference, deadline failures,
   queue wait, tool/capture errors and end-to-end latency separately. Recheck X04,
   deferred approvals, group and X01 before making the new default. No unrequested
   writes, lost updates, wrong targets or attribution errors are acceptable.

## Prototype contract resolved on 2026-09-23

- Default remains `tab-v1`. `BROWSER_COORDINATION_MODE=origin-v2` opts an isolated
  Gateway into the experiment; the mode is captured in each run configuration.
  The sidecar receives an optional mode and absolute deadline on every start/resume.
- Admission runs in the serialized MCP coordinator, after probing the real target
  and before dispatch. PreToolUse still owns egress/risk/approval and never guesses
  admission from stale persisted page metadata. Navigation uses the explicit URL
  origin; ordinary actions use the verified target's current origin.
- Gateway owns one FIFO pending/held entry per run, normalized HTTP(S) origin and
  workspace. Repeated acquire is idempotent, origin switching releases the old
  entry first, and renew cannot create or resurrect ownership. Held and pending
  entries have a 120-second renewable TTL (initial prototype value, not calibrated).
- Waiting is a cancellable host-side poll, not a model-visible retry. It consumes
  the same existing run wall-clock deadline, including the acceptance fixture's
  unchanged 300 seconds (the product's configured default is different). The SDK's
  MCP timeout is explicitly outside that deadline; Gateway remains the hard cap.
  Each transport request is also bounded. An expired/cancelled wait initiates
  best-effort release without blocking its return; process exit may interrupt that
  request, so terminal cleanup and TTL remain the fallback. No `waiting_browser` state or new SDK
  resume mechanism is introduced for ordinary queue waits.
- Human takeover preempts held origins into the existing FIFO queue and blocks
  grants. A waiting proxy receives the ordinary human-takeover response and
  cancels its entry. Handback never dispatches a stale call automatically. Current
  tab/epoch fences still apply before actions and screenshots.
- Actual terminal/park/cancel transitions release entries. Live approval waiting
  may renew existing ownership; an ahead-of-dispatch SDK hook must not release an
  origin that a previous in-flight action still uses. A parked approval has no
  origin lease; a resumed browser dispatch acquires again.
- A redirect is observable only after the browser action. Release the old origin,
  suppress capture under unverified ownership and require a fresh call/approval
  context before another action; do not auto-replay the potentially completed
  action. This cooperative tool-level coordination is not a network boundary and
  cannot make arbitrary browser scripts atomic across unknown origins.
- Queue/grant/release transitions record origin, outcome and waited milliseconds
  in the Gateway ledger without manufacturing sidecar sequence numbers. Retain
  end-to-end wall time and the original v1 wait diagnostic alongside v2 admission
  evidence. No production-default change is authorized by a passing unit test.

The user requested continued B3 development after reviewing the failed calibration.
This accepts the bounded prototype above, not a claim that origin locking fixes the
observed timeout or an exemption from the final paired acceptance gate.

## Consequences

The prototype adds an origin queue and a host wait within the existing SDK/MCP
path. It does not replace the agent loop, change SOUL/summary instructions, add
inter-bot permissions, extend run timeouts, or enable the mode in the main app.
Existing v1 behavior and original B/C evidence remain available. B3 stays open
until the concurrency dependency is resolved by the required evidence.

## Verification

Rows are implementation and acceptance obligations; results must be recorded separately.

| Decision | Concrete meaning | Test / evidence | Metric |
| --- | --- | --- | --- |
| 1 | v1 remains replayable; candidate configuration is recorded per run; no inter-bot ACL introduced | Existing architecture/static tests; `config.test.ts`, `browser-origin-routes.test.ts`, stdin round-trip tests; original B/C raw matrices | configuration completeness, interference rate |
| 2 | FIFO same-origin queue, parallel different origins, takeover exclusion, lease release and deadlock-free switching | `browser-origin-queue.test.ts`, `browser-origin-routes.test.ts`, `browser-coordinator.test.ts`; `m2-origin-coordination.container.test.ts`; full v2 real-tab switch/cancel/expiry/approval regressions remain adoption gates | wait duration, stale leases, wrong-target count |
| 3 | waits are runtime-owned, cancellable and accounted separately from active work; full latency remains visible | `origin-wait.test.ts`, `gateway-client.test.ts`, `run-once.test.ts`; runtime FIFO T2; full v2 real-SDK park/resume remains an adoption gate | queue time, execution time, end-to-end deadline failures |
| 4 | unchanged business oracles plus explicit versioned wait semantics; no failure discarded | Existing X02/X03 K5 runner and immutable raw evidence; planned v2 wait checks and X04/group/X01/approval regressions | interference, task success, lost updates, tool/capture errors, latency |

## Prototype result (2026-09-23)

The opt-in implementation is recorded in `716b235`. Deterministic tests pass, but
one configured-model X02/X03 solo/concurrent smoke completed only 2 of 8 runs;
6 hit the unchanged 300-second deadline. X03's waiting task spent 275 seconds
queued without a grant. The candidate is not approved for default adoption.
Solo failures also occurred without queue waiting, so neither queueing nor model
latency alone is established as the sole cause. See the
[prototype report](../design/m2-b3-origin-prototype-results-2026-09-23.md).
Reconsider whole-run origin holding and diagnose the solo failures before the
full calibration; do not enlarge the timeout or discard this failed repetition.

## Implementation clarification: modal-compatible identity (2026-10-12)

The identity probe must remain usable while a file chooser is pending. Issue #66
reproduced the pinned MCP rejecting a page-code probe before the upload/cancel
needed for recovery. A build-time, exact-source-fingerprinted MCP 0.0.82 shim adds
CDP target ID, live URL and current flag to its existing modal-compatible tab-list
handler. The coordinator consumes that same-session identity, never a guessed
URL/index or a cached permission. Upload/cancel still crosses the original hooks,
origin/target/takeover fences and MCP file policy; only its unnecessary page-focus
RPC is omitted. No new origin-queue policy or default-mode change is introduced.
Unpatched/malformed identity fails closed. Review and runtime limits are recorded
in [the #65/#66 report](../design/browser-evidence-chooser-results-2026-10-12.md).

| Existing decision | Concrete meaning | Test / evidence | Metric |
| --- | --- | --- | --- |
| 2 | modal recovery retains exact live target identity and takeover exclusion; no duplicate/fallback upload | `browser-chooser.container.test.ts`, `browser-coordinator.test.ts`, source-fingerprinted image shim; controlled two-session receipts in the linked report | wrong-target dispatches, duplicate uploads, modal recovery outcomes |
