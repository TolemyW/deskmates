# M3 long-bucket comparison repair

Date: 2026-10-03 (Asia/Taipei). Status: offline tool repair verified; full M3
and memory strategy acceptance remain incomplete. No SDK/model call, model
configuration read, campaign dispatch, deployment, commit or release occurred.

The M3 context/memory plan requires a memory strategy's paired success interval
above zero per duration bucket. The existing comparator deliberately excludes
long tasks for the older golden benchmark's smoke set. Applying that default
to a future frozen memory campaign would omit G-LONG from its rejection gate.

`evals/compare.ts` now accepts `--include-long`; the corresponding typed option
is `includeLong: true`. It includes long rows in the overall/per-bucket verdict,
fingerprint and cost calculation. JSON records `includesLong`, and Markdown
states the selected scope instead of claiming the included long tasks are only
smoke. Short and medium remain included. The original benchmark defaults,
pairing unit, confidence calculation and non-regression exit rule are unchanged.

Three new synthetic regressions fail before and pass after: shorter-campaign
gains cannot hide significant long regression; one long campaign pair remains
inconclusive; the CLI includes long rows and rejects `--include-long=false`.
All 18 comparison and 69 eval-tool tests pass. `npm run typecheck`, evals
TypeScript checking, root lint (701 files) and `git diff --check` pass.
The full container/model suites were not rerun for this measurement-only repair.

Private receipts are in `spikes/m3-memory-comparison-20261003/work-01`.
The new test source was copied before the failing invocation. Final source
copies were captured after checks; they are not represented as pre-test copies.

| Evidence | SHA256 |
| --- | --- |
| Before, 3 regressions fail | 7647af0ceb5f45bbebac60a29a6335482e6e2482dd40f0ecf4a12c5a705cc6c9 |
| After, 18 comparison tests pass | d1364d150dd25de92d3f26851645d81f1ec89e6f69bd1c40315227896450e625 |
| All 69 eval-tool tests pass | 87ddb7ff18c7862214b8980b6c4dc2ffc1a0c23305be8ba8801fab7d3cc18609 |
| Corpus/power planning audit | 86be6da9f96f45f74bbc49e6f912b98eaa0da5b2b2a425ba603304cd9a7103c4 |
| Source/check receipt | 463ae2265e0bcc5988743fda37d1ea081dc5e9a4a50f6b901d5f81a9a7c045a9 |

## Coverage and power limit

An offline aggregate-only audit of the existing prerequisite generator counts
54 cases: 3 short, 48 medium and 3 long. No real reservation or private model
campaign seed is created. With illustrative K=5, assumed baseline 0.8, one-sided
alpha 0.05 and target power 0.8, the existing power function reports:

| Bucket | Cases | Optimistic MDE | Conservative MDE |
| --- | ---: | ---: | ---: |
| Short | 3 | 40.55 points | 70.82 points |
| Medium | 48 | 9.75 points | 22.84 points |
| Long | 3 | 40.55 points | 70.82 points |

The optimistic bound counts K campaigns of each case as independent; the
conservative bound counts each case once. These are planning bounds, not
observed power. Short/long are not powered for a 10-point claim simply because
the total contains 54 cases. Do not duplicate the same cases or count their five
sessions as independent tasks to manufacture sample size. Legal session-order
randomization, the combined retention-off runtime controller, PDF/image poison
coverage, adequate sampling and configured-model results remain outstanding.

A zero comparator exit means no measured bucket is judged worse, including
potentially inconclusive estimates. It does not satisfy M3's positive-confidence
strategy gate or its independent safety/runtime prerequisites. No strategy is
adopted. Production packages, remote frozen candidate 42bab952, the two running
default-duration observations and the separately proposed model bundle remain
untouched. The prior frozen full gate is not relabeled as this new tree's gate.
