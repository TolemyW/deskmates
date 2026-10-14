# B3 origin-coordination prototype: work allocation

Starting revision: `5d1e08a`, already fast-forwarded to main. New work stays in
`codex/m2-foundation-20260922` and is not automatically merged or deployed. The
user requested continued B3 development and a concrete allocation. All three
subagents remain Sol-medium. Parent owns integration and model-run scheduling.

| Work package | Owner | File boundary and deliverable |
| --- | --- | --- |
| O1: origin queue | group agent | New Gateway migration/store/tests: FIFO, one origin per run, release-before-switch, TTL, renew, takeover and cleanup |
| O2: host admission | takeover agent | Sidecar coordinator/client/schema/config and cancellable wait; only minimal proxy close wiring; explicit MCP timeout; unit regressions |
| O3: capture diagnostics and runtime regression | golden agent | Proxy capture failure markers and tests, then a new real Docker/SDK scripted-origin acceptance test |
| O4: integration and evidence | parent | Shared contracts, Gateway mode/config/request/route/lifecycle wiring, audit events, ADR/plan, deterministic regressions and isolated model verification |

## Frozen behavior and gates

- Implement only the resolved opt-in contract in ADR-0007. Default `tab-v1` stays.
  Preserve the prior 10% failure and source/image attribution; do not pool versions.
- Keep model, role instructions, SDK turn limit and run timeout fixed. Acceptance
  queue time counts inside 300 seconds; report total duration and wait separately.
- The proxy capture marker correction is independent: timeout/no-image/oversize
  already failed before the tool result, so write an explicit skip instead of
  making the run wait another two seconds. This does not prove the underlying
  screenshot timeout or the model's over-verification is fixed.
- Unit/integration checks cover FIFO, origin switching, TTL/release, cancellation,
  human preemption, failed transport, deadline and redirect behavior. No guessed
  target repair, browser action retries, or model polling is introduced.
- Real Docker/SDK scripted checks must use ledger order or a barrier to prove
  waiting; wall time alone is not evidence. Verify no residual origin leases.
- Build dedicated images and validate the optional path on the configured model
  only after deterministic tests pass. A smoke result proves integration only;
  the full X02/X03 K5 paired comparison and X04/approval/group/X01 regressions are
  still required before adoption or closing B3.
- Main application processes, ports, data and default image tag are outside scope.
  Docs/ADR changes are committed separately from implementation.

## Outcome

Implementation and isolated verification completed in `716b235`. T0/T1 and the
focused deterministic runtime checks pass, but the configured-model smoke has
2 completed runs and 6 deadline failures across 8 runs. Keep `origin-v2` opt-in;
B3 is not closed. Diagnose solo completion and long-held-origin blocking before
K5 adoption calibration. See
[m2-b3-origin-prototype-results-2026-09-23.md](m2-b3-origin-prototype-results-2026-09-23.md)
for the failures, limits, image provenance and exact evidence scope.
