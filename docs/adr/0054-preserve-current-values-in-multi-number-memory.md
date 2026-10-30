# ADR-0054: Do not consolidate different multi-number memory bodies

Date: 2026-10-22
Status: Accepted (owner approved the proposal on 2026-10-22).
Scope: the duplicate-value decision in ADR-0011 amendment 2 A7/A10

## Context

The stable v0.7.10 real-model lifecycle check of 2026-10-22 found a deterministic
false consolidation. A trusted note said "current target 300, replacing 280".
The next trusted observation said "current target 280, replacing 300". The model
submitted the requested change correctly, but `memoryFact` sorted the numbers
into the same value, `is|280,300`, for both bodies. The Gateway recorded a
`deduplicated` outcome, advanced the old note's effective time and kept 300.
A normal operator undo recovered the original 280 note; this is a recovery,
not successful automatic supersession.

Sorting numeric sets cannot express the roles of current and previous values.
Simply preserving their order is also insufficient: two properties can exchange
roles without changing the sequence. The Gateway must remain deterministic and
must not infer a current value with a generative model.

Private evidence: **Stable live lifecycle and presentation acceptance,
2026-10-22**, including the original summaries, learned-memory receipt, current
entry versions and the operator recovery receipt. No paid paired memory
comparison is claimed.

## Decision

1. Keep fact keys, trust, source clocks, ordering, atomic writes and history as
   defined by ADR-0011. Do not introduce a model call or a human conflict queue.
2. For a note with more than one non-condition numeric token after the existing
   ISO-date and condition processing, consolidate with a current note only when
   their normalized bodies are equal. Otherwise write the newer observation
   through normal recency ordering, even when the numeric sets match. Repeated
   identical summaries remain idempotent per run and ordinal. Single-number and
   nonnumeric notes retain the existing equivalent-value rule.
3. Preserve the complete newer wording. Do not guess which number is current,
   strip a "previous" clause, or rewrite historical entries during an upgrade.
   A later observation takes effect normally; already recorded run context is
   immutable. New runs record `memoryValuePolicy: multi-number-body-v1`; learned
   write receipts name that policy so outcomes remain attributable after upgrade.
4. This trades additional versions for fewer destructive false consolidations.
   It does not solve false fact-key matches, semantic equivalence or diary
   provenance. Before calling the strategy better, run the already required
   paired protocol in ADR-0011 A14 under a separately authorized campaign.

## Verification

| Decision | Means | Test | Metric |
|---|---|---|---|
| 1 | Changed values supersede atomically without increasing trust or changing observed clocks | Existing `memory/recency.test.ts`, plus the regression below | current notes per key; trust changes |
| 2 | 280 -> 300 -> 280 with a "replaces previous" clause produces three versions and one current 280; exact repeats consolidate | Contracts `memory-recency.test.ts`; Gateway `memory/recency.test.ts`, English and Chinese; current stable live failure retained | false consolidation; extra versions |
| 2 | Swapped property roles with the same numeric sequence retain the newer complete body; repeated identical numbers count as multiple tokens; single-number paraphrases retain existing behavior | Contracts `memory-recency.test.ts`; Gateway `memory/recency.test.ts` | false consolidation; duplicate consolidation |
| 3 | Stored entries and frozen run version sets are not rewritten; old observations remain history; new runs and write receipts name the policy | Gateway `memory/recency.test.ts`, ledger run-config and learned-memory receipt tests | historical context mutations, exactly zero; policy attribution coverage |
| 4 | Quality claims require paired evidence, including false fact matches and poisoning | ADR-0011 A14 protocol; not run | recall, stale use, poisoning, version count |

## Implementation boundary

The owner accepted this change after reviewing the stable counterexample and the
additional-history tradeoff. Implementation and deterministic regression checks
follow that acceptance. No unreleased memory patch is applied to the stable
instance; a fresh tagged release and its gates remain a separate step.
