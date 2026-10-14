# B3 origin-coordination prototype results

Date: 2026-09-23
Code revision: `716b235`
Branch: `codex/m2-foundation-20260922`
Status: prototype implemented; configured-model smoke failed; do not adopt; B3 remains open

## Delivered scope

Three Sol-medium agents owned Gateway FIFO storage, sidecar admission, and capture
failure diagnostics/runtime tests. The parent owned the shared contract, Gateway
integration, review, isolated image and verification. Allocation is in
[m2-b3-origin-prototype-plan-2026-09-23.md](m2-b3-origin-prototype-plan-2026-09-23.md).

- `origin-v2` is explicitly opt-in; `tab-v1` remains the default. The mode is
  snapshotted per run. Each sidecar process receives its existing absolute deadline;
  queue time is included, and the SDK MCP timeout does not shorten that outer limit.
- A durable FIFO queue coordinates each workspace/origin. One run has at most one
  pending/held entry; switching releases first. Renewal cannot resurrect ownership.
  Expired entries disappear; takeover preempts grants; parking and terminal cleanup
  remove entries. Queue, grant, release, preemption and observed lease loss are logged.
- The host waits for origin admission after verifying the live browser target.
  Abort and deadline cancel waiting; human takeover requires a fresh tool decision.
  Admission is followed by target revalidation. Renewal between bounded RPC stages
  and sticky loss checks prevent an expired lease being mistaken for valid control.
  Redirects release ownership and reject an uncertain result without replaying actions.
- Screenshot failures now write explicit skipped markers when the filesystem permits.
  This removes the later redundant marker wait; it does not fix the screenshot failure
  itself or prove the previous model over-verification timeout is resolved.
- The model runner records candidate/baseline coordination modes independently.
  Ticket reports retain origin ledger events alongside unchanged historical oracles.
  Only the ticket suite accepts the new mode selector at this point.

## Deterministic verification

| Check | Result |
| --- | --- |
| Full T0/T1 | 1071/1071 passed across 77 files |
| TypeScript | Passed |
| Biome, affected packages and acceptance files | Passed |
| Real Docker/SDK default-mode browser approval resume | Passed, 1 case |
| Real Docker/SDK default-mode X04 human takeover | Passed, 1 case |
| Real Docker/SDK origin-v2 queue and Gateway takeover/terminal cleanup | Passed, 2 cases, final corrected fixture |

Image: `cogbot/workspace:m2-live-origin-prototype-20260923-r2`
Image ID: `sha256:4c387b97f406cdd523efeef16a3dee5b3cab0d8f25fb07670cfcd5c1c2c35402`
The earlier unsuffixed image was superseded before successful final verification.
Both tags are isolated test images; neither replaces the main app's image tag.

Raw validation logs are under ignored
`spikes/m2-business/work-origin-prototype-validation-20260923/`.

### Fixture failures retained

The first origin T2 used an unfinished navigation as its barrier. B's initial
browser probe failed with `Browser tab identity unavailable` before it reached
origin admission. The scripted upstream incorrectly treated any tool result as
success, and the test eventually timed out. The raw test log and a diagnostic
observation are retained; normal teardown removed the transient database before
it could be copied, so a complete internal MCP error trace is not available.

Inspection of pinned MCP 0.0.82 shows that response building obtains headers for
all tabs, including title reads; run-code completion also performs page settling.
An unfinished navigation can interfere with those steps. This is a supported
explanation, not an observed exact underlying error. The prototype does not fix
or claim coverage of peer initialization during an indefinitely loading page.

The replacement fixture waits at the fake model response after A's successful
navigation. B must appear as queued while its target HTTP request is absent; only
then is A's response released. B subsequently receives a grant, navigates, completes,
and leaves no entry. Both runs' persisted tool results must be free of errors.
A second fixture attempt exposed that the SDK may send a tool result upstream
before yielding it to the sidecar ledger. The premature ledger assertion was moved
after run completion, and cleanup now drains both runs before the next case.
Its failure log is also retained. No product timeout or business oracle was relaxed.

## Configured-model smoke

One fresh X02/X03 solo/concurrent repetition uses `glm-5.3`, cheap model
`glm5.3-flash`, site 1.2.1, maxTurns 35 and the unchanged 300-second run deadline.
Raw evidence is under `spikes/m2-business/work-origin-prototype-model-20260923/`.
This is integration evidence, not the K5 comparison required for adoption.

X02's two solo controls and two concurrent runs all hit 300 seconds. Both solos
had zero origin queue waiting. The refund solo successfully issued both label
writes, then continued verification and encountered stale-reference/argument
errors. The reassign solo reached the third requested ticket but did not perform
its write before timeout. In the concurrent pair, refund waited **178.912 s**
before its grant. The reassign run released after a stale-reference error and
then waited **84.578 s** on retry until timeout. Those Gateway transition times
prove queue occupancy; tool-call/result ledger intervals are not pure browser
latency because the SDK may yield those events later.

This is evidence of head-of-line blocking in the candidate, alongside independent
solo completion failures. It does not support enabling origin-v2, nor attributing
all four failures to the queue. The original B/C baseline failures remain intact.
A concise event analysis is retained in the validation directory's
`x02-runtime-analysis.json`.

| Scenario | Solo A | Solo B | Concurrent A | Concurrent B | Canonical scenario |
| --- | --- | --- | --- | --- | --- |
| X02: refund labels + reassign open tickets | 300.053 s, timeout; labels written | 300.076 s, timeout; writes incomplete | 300.115 s, timeout; writes incomplete | 300.117 s, timeout; writes incomplete | Failed |
| X03: comment + reassign ticket 1050 | 260.640 s, succeeded | 158.808 s, succeeded | 300.085 s, timeout; no origin grant | 300.078 s, timeout; writes incomplete | Failed |

**2/8 runs completed, 6/8 hit the unchanged deadline; both scenario gates failed.**
X03's solo controls passed all canonical and strict checks. Its concurrent comment
run waited **275.000 s** until cancellation without ever receiving an origin grant;
it therefore produced no screenshot. The screenshot-attribution diagnostic failed
for absence of a capture, not a demonstrated image attributed to the wrong target.
Both concurrent runs failed the runtime/requested-write gate. All arms retained
unchanged unrelated business state and distinct stable targets. These findings do
not establish a population failure rate from one repetition.

The X03 comment solo also recorded one expired origin lease followed by a fresh
grant before its next action; it still completed without a tool error. This shows
why TTL loss needs its own audit event, and is not evidence of an in-flight action
safely continuing under an expired lease.

The runner exited 1 after preserving all eight runs, state snapshots, checks and
origin events. No model repetition was discarded, retried or pooled with B/C.
Model verification took about 27 minutes. This smoke provides no evidence that
origin-v2 improves response time or reliability; whole-run origin holding should
be reconsidered before any further adoption calibration.

## Remaining gates and limits

- Diagnose the failed smoke before spending K5 repetitions: separate tool transport,
  model latency, unnecessary verification and whole-run origin holding. Any prompt
  or strategy adjustment needs its own paired experiment, not a bundled change.
- Repeat the prescribed X02/X03 K5 comparison with the explicit v2 wait oracle,
  keeping all prior B/C failures. Recheck X04, approval park/resume, group and X01
  under v2 before default adoption or declaring B3 complete.
- The 120-second TTL is a prototype value. Individual proxy RPCs are bounded at
  90 seconds and ownership is renewed between phases; this does not prove that
  an unacknowledged browser side effect has stopped when a connection fails.
- On deadline/abort, release is best effort without delaying return. Process exit
  may interrupt it; Gateway lifecycle cleanup and TTL remain the fallback.
- `waitedMs` measures admission elapsed time from the original queue entry. After
  human preemption it can include earlier held time because FIFO identity is kept;
  use transition timestamps to distinguish those intervals in a takeover analysis.
- Origins are cooperative scheduling keys, not inter-bot isolation or a network
  boundary. Unknown redirects and arbitrary browser scripts cannot be made atomic
  by this queue.

Main remains at `5d1e08a`. This iteration is not merged or deployed, and no main
application process or other agent's container was restarted.
