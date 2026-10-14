# M2 timeout reliability: phase timing and verified completion

Baseline: `d32a06c` in the isolated `codex/m2-foundation-20260922` worktree.
The origin-v2 smoke completed 2/8 runs; two solo runs also timed out without
origin contention. That evidence does not identify pure model or browser time:
SDK ledger delivery can lag the actual tool response.

## Work allocation

| Work | Owner | Deliverable |
| --- | --- | --- |
| Model transport | group agent, Sol-medium | Headers, first body byte, body and request spans; transparent stream and cancellation regressions |
| Browser host | takeover agent, Sol-medium | Serialized queue, coordination, real RPC, capture and fencing spans; bounded asynchronous telemetry |
| Completion experiment | golden agent, Sol-medium | Versioned opt-in fixture, paired runner provenance and overlap-aware timing analysis |
| Integration | parent | Shared types, run attribution, integration regression, isolated image/model tests and evidence |

## Fixed controls and decision rule

1. Framework timing adds no model-visible messages or decision changes. Preserve
   byte streams, tool arguments/results, safety checks, approval and takeover.
   Starts without ends remain incomplete; missing telemetry is never zero work.
   Nested intervals are not summed as elapsed wall time. First byte is not TTFT.
2. Use default `tab-v1`, the configured primary model, maxTurns 35 and the existing
   300-second ticket deadline. Do not enable origin-v2, switch to Flash or increase
   the deadline in this experiment. Main application, data and image tag stay outside
   this checkout's work.
3. Candidate `verified-stop-v1` changes only the fixture completion instruction:
   discover required targets, execute requested changes, verify required outcomes
   with visible evidence, then finish. Do not treat a successful click as verified
   completion or conceal partial/blocked work. No golden answers in the instruction.
4. After deterministic checks, run one paired ticket smoke (X02/X03, solo controls
   and concurrent arms) on the same instrumented image, baseline then candidate.
   Retain all attempts, failures, final states, config and hashes. This is an
   integration/diagnostic gate, not proof of a general strategy improvement.
5. A failed smoke blocks adoption and K5 expansion until the failure is understood.
   A clean smoke permits a separately reported K5 comparison and other B3 regressions;
   it does not close B3 by itself. The planned full `evals/compare.ts` does not yet
   exist; descriptive comparisons must explicitly acknowledge that missing gate.

## Measurements and limits

Record timing schema version and strategy version/hash in each run config. Record
model, source, image, fixture and order in the runner manifest. Run-owned asynchronous
browser telemetry shares the authenticated event route but does not borrow the SDK
event sequence; its attempt is explicit. Delivery has bounded memory and time; hard
process termination can lose samples. Model transport timing includes network and
upstream processing and cannot separate upstream queueing from inference. Completed
spans, incomplete spans and observed interval coverage are all reported.

Before real-model work: typecheck, affected tests, streaming/cancellation tests,
default browser/approval/takeover container regressions, and available trajectory
replay. Documentation and code are separate commits. No merge/deploy is implied.

## Outcome

Implemented phase observations and the opt-in fixture, then completed the fixed
16-run comparison. Both variants have four completed runs and four X02 timeouts.
The candidate passes X03's strict checks but remains experimental; no K5 expansion
or production-default change is justified by this failed smoke. See
[the results](m2-timeout-reliability-results-2026-09-23.md) for timings, failures,
test evidence and the next independent experiment priorities.
