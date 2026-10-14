# M2 messaging fixes and isolated model regression

Date: 2026-09-23. This follows the failures in
[m2-live-model-results-2026-09-22.md](m2-live-model-results-2026-09-22.md).
All work remains on `codex/m2-foundation-20260922`; no main-checkout deployment
or application restart was performed.

## Changes

Gateway fix and protocol source: `338ed6f`; final factual context rendering: `63967d5`.

1. **Final-reply idempotency.** Completion checks for an already-persisted bot
   message with the same run, thread, author and body (outer whitespace trimmed).
   A match records `final_reply/deduplicated` with the existing message ID. It
   does not append another message, publish another transcript event, consume
   another turn, or route another wake. Distinct progress/final replies and the
   same text from other runs or in other threads remain separate. Completion,
   dedup logging and cursor advancement remain atomic. This is not semantic
   similarity matching or deduplication of repeated tool calls.
2. **Recipient context v1.** The Gateway includes recipient identity, the original
   waking message sequence and per-message addressing from persisted mentions.
   The sidecar labels messages addressed to this recipient, everyone, another
   member, or no explicit recipient. Each message retains its own label when
   wakes coalesce; omitted messages are not reintroduced by truncation. This
   directly addresses the earlier ambiguity between a human asking the chief
   and the chief subsequently assigning an expert. Role-authorized teammate
   data can be used, but bot bodies and attachments remain untrusted and roles
   still decide whether to act. This is a context change, not a guarantee that
   the model will always follow its role.

The additive fields survive stdin validation; legacy payloads retain their old
rendering. `threadContextVersion: 1` is recorded in run configuration. For the
baseline image below, that means offered context: the old stdin schema drops
these fields. Image identity is necessary to tell which rendering the model saw.

## Controlled comparison

The focused test is `acceptance/m2-group-foundation.acceptance.test.ts`, invoked
through `spikes/m2-live/run.mjs --repetitions 5`. Both variants use the same
Gateway and contracts source trees, including the final-reply fix (the comparison
checks those trees even when sidecar-only commits differ). The one changed factor is
sidecar recipient-context rendering. No SOUL rules, model settings, assertions,
turn limits or routing rules differ between variants.

- Model: the project's configured `glm-5.3`; cheap model `glm5.3-flash`.
- Real Gateway, Docker workspace, Claude Agent SDK and model endpoint.
- Baseline image: `cogbot/workspace:m2-live-ce65438-20260922`,
  `sha256:12e681ad0cb87a7fb2bfef64540cc365ce8856d722c046026af257696daf56a9`.
- Final candidate image: `cogbot/workspace:m2-live-routing-facts-20260923`,
  `sha256:7b04a8d2251255e328102df01c8eae656037ca2ff0e9291e9cef4acf98e63617`.
- Four fixed short synthetic scenarios, five repetitions each: chief/expert
  aggregation, ordered group with one answer, concurrent explicit mentions,
  direct handoff to a background bus. Fresh bots, sessions and threads per case.
- Each variant runs to completion without automatic retries to obtain green.
  Baseline runs before candidate; wall times are descriptive, not causal latency
  evidence. Prompt-cache state and upstream model variability are not controlled.
- Limits: eight SDK turns, 180-second per-run timeout. Each case includes a
  1.5-second quiescence check. Dedicated image tags, ephemeral ports, isolated
  SQLite and Docker volumes keep the active app and other agents' work separate.

Evidence (local and Git-ignored):
`spikes/m2-live/work-fix-baseline-20260923/` and
`spikes/m2-live/work-fix-facts-20260923/`, containing manifests with exact
image IDs and fixture hashes, transcripts, run configuration, usage and events.
`spikes/m2-live/compare.mjs` validates complete paired matrices and matching
configuration, then produces the candidate's `comparison.json`.

The planned `evals/compare.ts` does not yet exist in this repository. The focused
report is therefore **inconclusive for general strategy improvement** and does
not replace duration-bucket confidence intervals, fingerprint checks or the
full golden-site suite. Even five passing chief cases would not prove that an
intermittent missing reply is impossible.

## Deterministic validation

- `npm test -- --maxWorkers=1`: **966 passed across 66 files**.
- `npm run typecheck` and `npm run lint`: passed.
- Unique workspace image build: passed.
- Syntax checks for the live wrappers and `git diff --check`: passed.

Regression coverage includes no repeated routing/budget charge on duplicate
completion, rollback without ghost events, different body/run/thread preservation,
coalesced/truncated recipient labels, actual lifecycle request/config attribution,
stdin round-trip validation and retaining untrusted bot wrappers.

M2 is not fully accepted by these checks: real browser tab propagation, shared
browser interference, approval/takeover recovery, group UI runtime QA and the
remaining B2–B5 work still have their separate gates.



## Final results

**Final factual rendering: 20/20 passed**, five repetitions of each scenario.
The legacy rendering with the same Gateway fix also passed 20/20. All 20 paired
outcomes passed in both variants. This establishes a passing focused functional
regression sample, not a statistically demonstrated reduction in missing replies.

| Scenario | Legacy | Final facts | Legacy mean wall time | Final mean wall time |
| --- | ---: | ---: | ---: | ---: |
| Chief/expert aggregation | 5/5 | 5/5 | 24.4 s | 26.6 s |
| Ordered group / one answer | 5/5 | 5/5 | 14.8 s | 15.7 s |
| Concurrent explicit mentions | 5/5 | 5/5 | 14.9 s | 15.9 s |
| Direct background handoff | 5/5 | 5/5 | 14.4 s | 16.8 s |

Both variants used 85 runs. The Gateway suppressed **two** attempted repeated
final replies in the baseline and **three** in the final candidate, leaving zero
same-run duplicate transcript rows in either matrix. Expert replies, aggregation,
intentional observation silence, explicit parallel starts and background bus
handoffs satisfied the unchanged oracles. Empty final replies after a tool post
continue to use the existing `silent` status semantics.

The full test-process durations were 351.37 seconds (baseline) and 383.03 seconds
(final candidate), including setup and teardown. This change is not claimed to
improve latency; the observed candidate means are higher, and added context costs
prompt tokens. Sequential samples with uncontrolled upstream timing/cache state
cannot attribute that difference to the context alone.

The final test fixture SHA-256 in both manifests is
`79a8302759c5ad083f6d2d42e9a5f6610bfeb20f081ec0c5c7ca6d2e12ccc8fd`.

| Recorded token counter | Legacy | Final facts |
| --- | ---: | ---: |
| `inputTokens` | 231,679 | 246,859 |
| `outputTokens` | 12,823 | 13,190 |
| `cacheReadTokens` | 1,772,032 | 1,774,592 |
| `cacheCreateTokens` | 0 | 0 |

Cache counters remain separate from input/output counters. The isolated stack has
no price table, so costs are unpriced; no monetary amount is inferred.

After all three fixed matrices, Docker listed none of their test containers. The
existing app container `cogbot-ws-ws_be37a272506b4233ad307386583411cb` remained
healthy on image `8a575525c985`. Main stayed at `a0d29a1` with its pre-existing
untracked QA/research files untouched. No schema migration or production restart
is required to review the change; deploying it later requires the matching
Gateway code and a rebuilt sidecar image.

## Rejected first candidate

The initial rendering at `338ed6f` included general advice about acting on
role-authorized teammate data and staying silent when there was no further work.
Its complete fixed matrix passed **17/20**, compared with **20/20** for the legacy
rendering with the same Gateway dedup fix. It was not accepted, and failed cases
were not retried or removed:

- `chief1`: both experts answered and the chief produced 96, but its delegation
  omitted the required `CHIEF_ASSIGN` marker. The strict assertion stayed failed.
- `direct1`: the expert chose `message_bot` to reply rather than the current bus
  thread; its recipient was not configured for that tool. After failed attempts
  it tried `ListAgents`, which correctly entered the existing approval path.
- `direct3`: the chief returned tool-like markup as ordinary text. The ledger
  contained no actual tool invocation and no handoff was created.

This does not prove the added prose caused every failure, but it supplies no
basis to accept that rendering. The final candidate removes the behavioral
advice and retains only recipient facts plus the reminder that existing SOUL,
human instructions and untrusted-message handling still apply. It is a changed
candidate evaluated on the full fixed matrix, not a rerun of the same candidate
until green. Candidate selection on these four scenarios still cannot establish
general model reliability.

The first candidate remains reproducible as
`cogbot/workspace:m2-live-routing-v1-20260923` with image ID
`sha256:baf07dcfd0e785dd47aff187de180798e7c72439f9ee5359c350c41bfeeb2663`.
All its evidence remains in `spikes/m2-live/work-fix-candidate-20260923/`.
The failed-case snapshots may precede late completion of another run in that
case; their usage counters must not be treated as a complete billing total.
