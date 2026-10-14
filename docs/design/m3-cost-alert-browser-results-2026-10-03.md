# M3 cost-alert browser regression

Date: 2026-10-03 (Asia/Taipei). Uncommitted working tree based on `1109ec7`.
Status: response-order repair verified; broader M3 acceptance remains incomplete.
No commit, release or deployment. All usage below is synthetic, not model spend.

## Finding and repair

The built Costs screen with real Gateway listeners reproduced a response-order
bug. An SSE-triggered GET captured two open alerts and was held by a loopback
transport proxy. Acknowledge then correctly persisted the operator decision and
its fresh GET removed that alert. Releasing the older GET restored the acknowledged
alert and its Acknowledge button in the UI. The database retained its correct
acknowledgedAt and human:web attribution; the failure is stale UI state.

`CostAlertsPanel` now assigns a revision to each paired alert/rule reload and
accepts only the newest response or error. Starting an operator mutation
invalidates earlier reads, and effect cleanup invalidates reads and unsubscribes.
The repair changes no alert evaluation, pricing, scheduling or budget policy.

Three regressions hold an older response while a newer operation finishes:
acknowledge must not resurrect an alert, delete must not resurrect a rule, and
a late failed GET must not replace the successful refresh with an obsolete error.
All three failed on the original code and passed after repair; the four existing
panel tests also pass. The first regression attempt failed in test setup because
mockImplementationOnce did not update the fake fetch helper's private call log;
counting the complete Vitest mock-call log corrected that fixture. Its failed
receipt is retained separately and is not counted as reproduction evidence.

## Actual browser verification

`spikes/m3-web-cost-alerts-20261003/fixture.ts` starts the built production UI,
the production sandbox/operator Gateway listeners, SQLite and the existing fake
provider. All three listeners bind loopback with ephemeral ports. It uses only
public test credentials and synthetic usage; the upstream fetch stub throws on
any call. No real SDK, upstream model or Meta endpoint was called.

The successful fixture (`work-02`) ran from 16:08:20 to 16:23:05 UTC on October 2.
Before repair it recorded the regression above, including the server's persisted
acknowledgement at 16:11:42.770 UTC. `race-before.jpg` shows the resurrected
$0.001000 known-cost alert after release of the old snapshot.

After rebuilding and reloading the browser, a fresh $0.002000 known-cost rule
was created through the UI. Another synthetic priced run triggered its SSE
notification while an older snapshot containing both the new known-cost alert
and the unpriced alert was held. The UI acknowledged the unpriced alert;
a fresh GET showed only the new known-cost alert. Releasing the older snapshot
at 16:22:44.198 UTC did not restore the acknowledged unpriced alert. Applying
filters displayed the correct totals: **3 runs, 250 input tokens, $0.002000 known
plus 1 unpriced row**. The unknown model row still displayed Unpriced, with
knownCostUsd null in the server report, rather than zero dollars.
`race-after.jpg` preserves this actual rebuilt UI. These amounts are synthetic.

The initial `work-01` fixture failed during setup: the attempted bot name
`QA bot` violated the existing name validator. It was corrected to `qa-bot` in
a fresh work directory. That attempt ran no browser journey or model call;
its startup receipt and database remain separate. The fixture stopped cleanly,
recording three fake-provider runs and zero upstream calls; listeners and the
temporary browser tab were closed. Databases/receipts remain in ignored private
work directories, not the stable deployment.

## Checks and bindings

- Affected Web and Gateway tests: **22 passed**, zero failed/skipped. An initial
  local invocation had 18 pass/4 loopback-listener permission failures; rerunning
  the same selection with network permission passed without source changes.
- All-project T0/T1: **2,456 passed**, zero failed/skipped; JSON success true.
- Web typecheck, backend/acceptance typecheck, lint (698 files) and production
  Web build passed. Fixture standalone typecheck passed with `--lib ES2022`,
  matching backend configuration. The default DOM-lib attempt hit an existing
  Gateway Buffer/BodyInit overload mismatch; it is retained separately.
- The repaired bundle is `index-Es0S85KJ.js`; the observed pre-repair bundle was
  `index-CIYqfPpe.js`. Full source/fixture/lockfile and repaired bundle SHA256s are
  recorded in `work-02/repair-binding.json`. Receipts include both regression
  attempts, before/after selections, full T0/T1, server API facts and screenshots.

This actual browser evidence uses a fake provider and synthetic usage, so it is
not real-model or WhatsApp acceptance, and it does not certify the retained
full-T2 screenshot failure. ADR-0018 remains Proposed. Remaining M3 gates stay
listed in `m3-closeout-inventory-and-plan-2026-10-02.md`.
