# Delivery clipping: lifecycle characterization, 2026-10-24

The owner requested tests for the third self-improvement finding before any
production fix. `packages/gateway/src/threads/delivery-clipping.test.ts` uses the
actual in-memory database, message/router stores, `RunLifecycle.start/ended`
and delegation attribution. Its provider is fake; no model, Docker or browser
is involved. These are characterization assertions for current behavior,
not acceptance criteria that a future fix must preserve.

## Results

Three deterministic T1 cases pass on the current implementation:

1. At a payload budget of 24, an earlier must-reply human request and later
   context coalesce into one queued worker run. The earlier request is omitted
   from the actual `StartRunRequest`, but `config.mustReply` is true and
   `deliveredSeq` covers it. An empty completed reply becomes `failed/no_reply`;
   the member cursor advances beyond the omitted request, which is absent
   from the next wake. The original message remains in transcript history.
2. With the same inputs and a budget of 2,000, both messages reach the worker.
   The same must-reply and cursor behavior then has its intended context.
3. An early bot delegation is omitted from the worker's request after later
   context exceeds the budget. `delegationsOf` still attributes that omitted
   instruction to the worker and completion produces a delegation outcome.

This confirms an accounting/context discrepancy beyond the original pure
function probe. It does not measure how often a real model misses work, nor
prove irrecoverable transcript loss: the original rows are retained. No CJK
tokenizer accuracy ratio or long-run reliability estimate was measured.

## Follow-up boundary

No production clipping, cursor, token estimate, must-reply or delegation logic
changes in this PR. A future design must choose how to protect actionable
messages under a finite budget and reconcile cursor/outcome accounting with
the actual payload, including coalesced wakes and resumed sessions. Change the
characterization expectations alongside that fix rather than weakening or
skipping the new tests.
