# M3 owner-approved scope closeout and M4 backlog

Decision date: 2026-10-03. Status: M3 closed under the owner-revised scope;
original full-runtime and statistical acceptance remains unfulfilled.

The owner explicitly moved the remaining gates to M4 and requested submission
of the accumulated changes and fixes. This is a scope decision, not a new test
result. It supersedes earlier statements that these open gates must delay M3.
Historical receipts and their source/image bindings remain unchanged.

## Revised M3 closeout

The implemented candidate and reviewed offline acceptance hardening form the
revised closeout: replay egress-approval attribution, equity artifact audit and
marker validation, regenerated/withheld-input quant verification, and memory
oracle completeness plus a fail-closed conditional numerical screen.

The original `fullM3Acceptance` and `statisticalGatePassed` remain false.
No model-quality, powered strategy, complete runtime, natural 24-hour, or visual
acceptance is inferred from implementation or fabricated evaluator self-tests.
This decision does not waive release/deployment safety gates in AGENTS.md.

## M4 acceptance backlog

| Work carried forward | Evidence required before calling it accepted |
|---|---|
| Visual UI acceptance | Actual browser checks against the integrated revision, including interrupted/repeated flows and operator review |
| Docker/runtime and domain scenarios | Current source/image-bound T2 and actual-domain T3 receipts, retained failures and exact owned-resource cleanup |
| Real-model and memory campaigns | Complete bounded runtime/reset driver, independently powered frozen corpus, cluster-aware inference, valid session/proxy/store evidence, all attempts and token accounting; obtain any required new scope/budget approval before launch |
| Statistical strategy acceptance | Canonical per-bucket comparison with correct independent clusters, safety/reliability checks and adequate power; do not promote the conditional screen to acceptance |
| WhatsApp manual acceptance | Owner's manual phone linkage and live message acceptance after the version is stable; QR is the primary path, Cloud API remains optional |

Owner amendment (2026-10-05): natural 24-hour soak is removed from M4 gates.
Preserve historical observations and continue validation after stable release.
This does not certify any runtime, model, safety or statistical result.

## Validation retained at submission

The reviewed 16-file patch is bound to source base
`a3df29e27bd4c9797cd3fbf9382580c4b27733cb`. Its final offline full suite recorded
2,615 passes, two unchanged host-network failures and two unhandled environment
errors (exit 1). Root typecheck/lint, web typecheck/build and focused hardening
checks passed. This is not an all-green suite. Actual T2/T3 and paid-model runs
were not performed for this patch. See
[m3-offline-acceptance-hardening-2026-10-03.md](m3-offline-acceptance-hardening-2026-10-03.md).

## Integration state

At submission preparation, `main` was
`7969f71626dd01279dace4a7f226f7d9d94d5b50`, while
`claude/dreamy-darwin-ld0jvr` was
`a3df29e27bd4c9797cd3fbf9382580c4b27733cb`.
They diverged: the Claude branch had 25 commits absent from main and main had
two documentation commits absent from that branch. Main did not contain the
complete candidate or this patch. The submission is a separate branch and
**dependent draft PR targeting the Claude branch**, not a merge into main.
The existing collaborator branch is not overwritten. Before eventual main
integration, preserve main's newer documentation/observation receipts and
reconcile this scope amendment; obtain merge authorization separately.

## Integration clarification (2026-10-04)

<!-- current-status:start -->
M3 is closed under the owner-revised scope. M4 is in progress.
Task management (ADR-0021) is merged; runtime, real-model, statistical,
visual acceptance remain pending.
Natural 24-hour soak is not an M4 gate; validation continues after stable release.
<!-- current-status:end -->

The Integration state section above is the historical submission-preparation
snapshot, not the present branch state. The M3 scope amendment is now in the
integrated main snapshot `6bf09f1`; the subsequent operator Task management
slice merged as PR #3. Its CI run `37191471153` passed 2,710 root T0/T1 and 277
Web tests. That later offline receipt does not rewrite the retained 2,615-pass,
exit-1 receipt above or satisfy the deferred runtime/model/statistical gates.
See [M4 status](m4-status-2026-10-04.md) for the current bounded evidence ledger.
