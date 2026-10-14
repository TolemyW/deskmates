# Stock scenario message-budget pilot

Date: 2026-10-01. Status: completed; both fresh instances failed. Increasing the
thread budget from 8 to 16 did not complete this scenario. No production default
or release changed, and no statistical improvement is claimed.

## Question and fixed inputs

The owner requested a parameter adjustment grounded in real scenario results.
The previous release-validation stock instance exhausted eight bot messages
before the risk-to-lead handoff. That observation justified testing a higher
budget; it did not establish that 16 would work.

The predeclared pilot ran one fresh control at 8 and one fresh candidate at 16,
sequentially, with one human task submission per instance. Both used v0.2.18
(`543f693`), the same workspace image
`sha256:270a722a76b93f7ed4d4a6e465079dc411ca94c4a1c85023fec2a602f7592fe8`,
LLMOps GLM-5.3, the same four bot roles and unchanged SOULs/source pack. The
scenario fingerprint was
`28ca53ae0a33740394d528593d40a3884cfbc2f9c090419becfc724c2d8d3a9a`.
Every run records the tested budget in `config.strategyEvidence`.

Other limits stayed fixed: 18 turns / 300 seconds per physical run, three
concurrent runs, 8192 MiB workspace memory, owner-v1 routing, relay depth five,
900 seconds scenario observation. The harness did not resubmit tasks, resume
paused threads, change prompts or approve external actions. The candidate's
lead independently requested an in-task recovery after a specialist failed;
that failure and every subsequent run remain in the results.

Experiment source and oracle were recorded before launch. All 1138 transferred
source files matched their hashes; the subsequently transferred audit script
SHA256 was `8bb89f225fa64db064eed8bb2971b9737fe0b1537e63fa9a02f0126c13501fa0`.
The test-only harness was typechecked locally; the release source was typechecked
on Testbox. No package implementation changed and no new T0/T1 or full T2 suite
was run for this parameter-only pilot.

## Observed results

| Observation | Budget 8 control | Budget 16 candidate |
| --- | --- | --- |
| Process wall time, including setup/cleanup | 661 s | 516 s |
| Logical runs | 6 | 14 |
| Bot-authored messages | 6 | 17 |
| All four roles contributed | Yes | Yes |
| Final investment report | Missing | Missing |
| `strategy.json` | Present, unfinalized draft | Missing |
| Risk review / strategy draft | Present | Present; draft revised |
| Completion marker / task oracle | Failed | Failed |
| Routing blocker | Relay depth 6 exceeds 5 | Thread message budget reached at 16 |
| Other run failures | None | One 18-turn failure; one queued cancellation |

The control chose a serial path: lead → researcher → lead → strategist → lead
→ risk → lead. The sixth bot message was stored, but its mention was not
delivered because its relay depth was six. The thread's eight-message volume
budget was not exhausted. The strategist had already written `strategy.json`,
but the risk reviewer listed unresolved changes and the lead never finalized a
report. File existence is not a completion verdict.

The candidate initially assigned all three specialists in parallel. The
researcher's first run reached the 18-turn limit; the lead narrowed the
remaining assignment to NVIDIA. Source verification eventually completed.
Risk found a reproducibility error in the initial draft: the verification flags
would produce different weights from those actually printed. The lead requested
a revision and later added the review's detailed findings.

Message #23 was the sixteenth bot message. Its additional instructions to the
strategist were stored but did not wake it; a queued researcher run was
cancelled. An already-running strategist finished revision 2 and posted message
#25, the seventeenth bot message. Its mention of the lead was also suppressed.
In-flight runs explain why the final message count exceeds the budget; the
budget gates routing, not storage. Both final delivery files are absent.

Candidate bot-message counts: lead 8, researcher 4, strategist 2, risk 3. The
trace includes an unaddressed retry followed by the addressed version, interim
coordination notes, and extra completion replies. These are concrete sources of
budget consumption. Task failure is not merely the oracle rejecting a recovered
run: the final deliverables really are missing.

The model chose different paths in the two arms. Thus the shorter candidate
duration and different failure mode cannot be attributed solely to the budget.
This is a diagnostic pair, not the K=5 paired efficacy protocol in the measurement
design, and it supplies no reliability estimate.

## Output quality checks

The revised candidate draft fixes the verification flags and incorporates an
aggregate equity cap. Its three weights of 0.233333 plus cash 0.300001 sum to one.
It labels the cap as judgment-based, acknowledges missing price histories, and
retains `backtestStatus: not-run`. These are observed partial improvements within
that instance, not a final acceptance or evidence of profitable strategy.

It still fails a basic rule-consistency review:

1. The equity budget is `min(1 - minimumCash, 0.70)`. At the 10% drawdown review,
   raising minimum cash from 0.10 to 0.25 leaves the budget at 0.70 and the
   existing cash at approximately 0.30. The claimed tightening does not reduce
   exposure for these inputs.
2. At the escalation step, minimum cash 0.40 implies equity at most 0.60, while
   `bindingLimitAtEscalation` says 0.70. Those statements cannot both describe the
   binding constraint. No final reviewer approved this revision.
3. The strategist calls effective-position count 2 the conservative end of
   1.5–2, although its own formula permits 70% equity at 2 versus 52.5% at 1.5.
   The count itself was not estimated from a price series.

The control's risk review also needs scrutiny: it compares 106% historical YoY
growth with 12.2% guided QoQ growth and calls that a collapse. The periods are not
directly comparable. A reviewer bot's claims are not an independent oracle.
These checks inspect generated rule consistency; they do not certify every
financial statement, run a price backtest, or supply investment advice.

## Usage and isolation

| Recorded tokens | Budget 8 | Budget 16 |
| --- | ---: | ---: |
| Input | 247,810 | 314,490 |
| Output | 58,874 | 89,370 |
| Cache read | 1,269,248 | 3,118,592 |
| Cache create | 0 | 0 |

Twenty logical runs were retained; nineteen have usage. Candidate run
`run_7227e296d3444112a9df69670e047840` was cancelled while queued with
`startedAt: null` and has no usage row. Its usage remains unknown, not an invented
zero. The failed 18-turn run is `run_50399b0f0e79402b87c9f7e39ebce2c7`.
No approval events were recorded. Process exit code zero in both arms indicates
the harness completed and saved results; it does not mean the scenario passed.

Host evidence remains at
`/home/owner/agent_workspace/deskmates-reusable-stock-budget-20261001`:
each arm's SQLite ledger, scenario receipts, artifacts, timestamps, source
inventory, `audit.json`, `evidence-files.json`, and `cleanup-verification.json`.
The 22 copied artifact files match the host hashes. Local detailed evidence is
under ignored `spikes/stock-budget-20261001/work-results/`.

Both exact owned workspaces were verified to have no remaining containers,
workspace networks or volumes:
`ws_abd7a45aa5ab419a8a762c75fb56836d` and
`ws_bf64c7dd9737424eaa7e32bf1896bffb`. The stable service remains active on
v0.2.18. No stable database, credential, deployment setting or default was
modified.

## Decision

Do not adopt 16 as a proven fix and do not silently increase another limit.
The observed barriers are separate: serial relay depth, message volume inflated
by coordination/recovery, and a specialist's physical turn limit. Final strategy
consistency is a fourth concern that a higher cap cannot validate.

The next experiment should target one observed cause with a declared oracle:
reduce redundant coordination while preserving specialist evidence and a final
risk-to-lead closure, or separately test the specialist turn limit. A production
change to relay semantics requires an ADR. Any later candidate must independently
check final report delivery, final-revision risk review, and executable rule
consistency; a completion marker alone is insufficient.

Reproduction plan and scripts: [`README`](../../spikes/stock-budget-20261001/README.md).
Compact machine audit: [`results-summary.json`](../../spikes/stock-budget-20261001/results-summary.json).
Offline rule checks: [`manual-review.json`](../../spikes/stock-budget-20261001/manual-review.json).
