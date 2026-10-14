# ADR-0028: Recorded, tool-free approval presentation summaries

Date: 2026-10-11
Status: Accepted (implementation merged in PR #59; real-model acceptance pending)

## Context

Long approval instructions currently dominate the transcript. The owner requested
an automatic explanation from the default model, with original details collapsed.
ADR-0002 keeps model calls in the sidecar. ADR-0023 freezes a run's models and
restricts the proxy to them. Reusing an interactive run's token for a different
model or calling a model from the Gateway would violate those boundaries.

## Decision

1. For a new, non-rule-matched tool approval with more than 800 source characters,
   queue one ordinary background run of the requesting bot. Freeze DEFAULT_MODEL
   explicitly on this run. Its trigger reference names the approval. Do not
   backfill historical approvals or retry failed summaries automatically. The
   approval is posted immediately; summary generation never gates its decision.
2. The sidecar recognizes this presentation job before normal agent setup. Run a
   fresh SDK query with one turn, no tools, plugins, skills, sessions or workspace
   instructions, a bounded input and a 45-second deadline. Wrap the redacted
   source as untrusted data. Ask for a plain, short explanation in the source's
   language, including external effects and uncertainty, never an approval verdict.
3. Record the summary run, configured model, proxy requests and SDK usage with the
   existing ledger and pricing. Store a bounded summary with its run reference
   separately from the action. Never change the action, instruction, matcher,
   decision, transcript, routing, memory or learned behavior from summary output.
   No real-model quality improvement is claimed without measured acceptance.
4. The UI labels generated text as AI summary, leaves the actual risk, tool and
   target visible, and places full arguments/instruction behind an explicit
   disclosure. Old or failed records say that no summary is available. Summary
   jobs do not appear as conversational bot activity. Jobs remain visible in the
   run ledger and cost accounting.

## Verification

| Decision | Concrete meaning | Test | Metric |
|---|---|---|---|
| 1 | One queued default-model run per eligible approval; no historic backfill | approval-presentation.test.ts | summary run count per approval |
| 2 | Fake SDK sees no tools/session and bounded data; implementation configures a 45-second deadline | presentation-summary.test.ts | query count, elapsed time, failed jobs |
| 3 | Completion updates only presentation, keeps usage and decision | approval-presentation.test.ts | attributed input/output/cache tokens |
| 4 | Disclosure initially closed, raw source retained, generated label visible | approval-card.test.tsx | card height and visual checks |

## Limits

Source is capped at 12,000 characters and output at 700; a summary may omit
important details, so the full original remains available. Background lane
occupancy can delay it. Missing usage stays unknown in the model request ledger.
No paid model campaign or stable deployment is included in this change.
