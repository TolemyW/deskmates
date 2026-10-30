# Long-horizon harness integration

Date: 2026-10-19
Scope: issue #3's committed long-horizon harness; preparation evidence only.

The maintained runner is in `evals/long-horizon/`, adapted from the private lab
material dated 2026-10-11, titled **Long-horizon mission feasibility**. That
prototype's historical outcomes are not rerun or reattributed by this change.
The current runner uses Deskmates packages, the maintained acceptance stack,
current nullable usage receipts and per-attempt run timelines.

Two declarations cover a long single sweep and a dependent chat/cron mission
with a plan file, idle Gateway restarts and one audited golden-site checkout
approval. The final oracle independently checks the frozen eligible ticket
set, exact state changes and operation order, mutation counts, the expected
order and absence of collateral changes. Agent status and answers are
diagnostics and intermediate checks, not the final outcome oracle.

The deployment observer reads the operator API only and follows run, event and
transcript pagination. Its export includes background jobs, recorded run
configuration, lower-bound receipts, complete or unknown token dimensions,
Gateway-priced cost and every attempt's timeline. Logical run usage is
deduplicated. Incomplete usage, absent attempt marks and unobserved posted runs
make the relevant totals unknown. Each mission/arm/repeat is reserved before
setup and is never overwritten on retry; phase reports are written atomically.

The opt-in acceptance test is disabled in default execution. Its preflight
allows only configured models whose price rows are all known zero. A numeric
paid ceiling does not grant permission to run a paid campaign. No model was
contacted to implement or verify this integration.

## Verification

Local deterministic tests cover reference outcomes and negative/unknown oracle
controls, declaration validation, absolute deadline arithmetic, paginated
operator observations, token and attempt accounting, explicit opt-in and
zero-price gating, and reservation/export guards. The dedicated TypeScript
project and formatting/lint checks pass. The acceptance entry point was loaded
without opt-in and reported its single test as skipped. Exact commands are in
`evals/long-horizon/README.md`.

## Not established

- No new real-model L01 or LH01 run, current deployment observation, restart or
  approval journey has been executed by this integration.
- Restarts occur between phases. An in-flight crash or tagged upgrade and
  exactly-once external effects across an upgrade remain separate acceptance.
- Resource readings are sparse samples, not a measured peak guarantee.
- This two-mission smoke set has no measured regression power or confidence
  interval. Paired strategy adoption still follows the measurement protocol.
- This report closes the harness preparation gap only; it does not declare
  issue #3, M4, or a long-horizon strategy accepted.
