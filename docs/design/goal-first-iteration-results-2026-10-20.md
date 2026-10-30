# Goal-first working iteration — 2026-10-20

Baseline: `v0.7.8`, `b4f7688f708351f76ed5ee77667f91e7ae893d75`.
Branch: `codex/goal-first-automation`. Tracks issue #69; proposed semantics are in ADR-0052.
This is an isolated working iteration, not a release or milestone closeout.

## Implemented slice

- The default assistant's group tool can post an initial assignment through the existing
  router. An identical request in the same run reuses the group and creates no second message,
  wake, audit or source notice. Private source audiences carry over; no transcript is copied,
  no allowlist is expanded, and the group is structurally audited without its title/body.
- The new assistant SOUL/tool guidance prefers reuse, starts delegation through the actual
  group contract and asks only consequential setup questions. Existing saved SOULs are not
  overwritten. Prompt effectiveness is unmeasured, not inferred from routing tests.
- Task revision is one explicit feedback-and-Run request. Reopening, scope advancement,
  submission and audit commit together, or roll back. The same key survives a lost response.
  A delivery with the prior scope version is refused. Previous publications remain readable.
- Full delivery summary/outstanding items are no longer truncated. Structured output appears
  before execution diagnostics and file lists; explicit limitation fields are displayed first.
  Output is inert text, with schema shape checks distinguished from correctness.
- The daily memory exclusion reads persisted input entry/version triples: no second submission
  of the same version in 24 hours, including after service reconstruction. Other notes and
  versions remain eligible. The displayed daily number says submissions including failures.
- Internal model/maintenance jobs no longer replace the latest user-work status. Their full
  history remains visible as background processing. SOUL instructions are reachable in the
  everyday settings through a disclosure; model, approval and other tuning controls stay hidden.
- Five UI locale catalogs and the contextual task help reflect these changes. The demo adds
  explicitly fictional review limitations to exercise the result presentation.

## Verification record

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed across all configured projects |
| `npm run lint` | Passed |
| `npm run docs:check` | Passed; traceability only |
| `npm test -- --maxWorkers=8` | 876 files, 8,262 tests passed; 163.47 seconds |
| `npm run build -w packages/web` | Passed; the existing large-chunk warning remains |

Regression coverage completes the original delivering run before requesting a revision and
verifies its publication is retained, one new submission, rollback, idempotent lost-response
retry, stale-scope refusal and feedback preservation on a concurrent edit. Collaboration tests
cover source audience, an empty assistant allowlist, one recipient wake and repeat-call dedupe.

Browser material: **Goal-first iteration UI evidence, 2026-10-20**. The local demo was inspected
at a desktop viewport in everyday Use mode. It showed limitations on the initial review screen,
the feedback form, submission changing the task to In progress, and instruction editing without
Tune. The preview was reset to its fictional delivered state afterwards. Captures and command
logs are retained locally; private-lab archival is pending. No private deployment data was used.

## Limits

This is the historical local-demo record. The owner's later configured-model functional check
and fixes are recorded in `goal-first-real-model-results-2026-10-21.md`; its remaining memory
findings and pending strategy evaluation do not retroactively turn this demo into live evidence.

The demo has no execution engine: its submitted state is layout/interaction evidence, not a
real agent finishing a revision. Gateway tests use the fake provider and the real route/store
logic. No real-model call, new T2/T3 campaign or stable deployment was performed. SOUL/tool
guidance needs the paired strategy protocol before any quality/cost improvement claim.

This iteration does not implement automatic goal extraction, per-occurrence recurring-plan
acceptance, work-end episode generation, automatic memory promotion, or task live subscriptions.
Those retain their existing semantics and remain later slices of #69. Mobile and second-role
browser journeys were not exercised. Existing full-history/authorization tests remain relevant
but do not substitute for those live acceptance journeys.
