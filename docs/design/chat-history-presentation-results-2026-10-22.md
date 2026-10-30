# Chat history presentation follow-up — 2026-10-22

## Trigger and observed runtime outcome

The operator reported repeated errors and unreadable handoff notices in an assistant's
private chat on stable v0.7.10. This follow-up examines the existing lifecycle acceptance
recording; it makes no new model calls and does not change the stable installation.

Across that recording's 47 retained runs, three are failed: two report the unavailable
fallback model, and one background model job exceeded its 55-second deadline. This is an
acceptance inventory, not a reliability estimate or a claim about all production history.

The screenshot combines several different facts:

- The assistant submitted a private handoff successfully.
- The analyst returned the independently checked result, 214 / 280 × 100 = 76.43%.
- The assistant's subsequent source-chat continuation failed. Its primary model request
  ended with an error after approximately 15 ms, before recorded response headers. The
  SDK switched to the configured fallback, which reported that the selected model was
  unavailable or inaccessible. The primary request's precise transport cause is unknown:
  neither its HTTP status nor response body is in the captured request span. The narrow
  Gateway journal inspection did not supply that missing cause.
- A separate assistant run completed in the pairwise conversation. Its success does not
  make the failed source-chat continuation a success.

The real continuation failure must remain visible. Repeated system protocol, full stacks,
and the misleading scheduled-work label are separate presentation defects.

## Changes and scope

This implements the disclosure and attribution principles of ADR-0033 and the private
handoff presentation of ADR-0024. It does not alter routing, model-facing messages,
fallback configuration, run status, approval policy, or the ledger.

Persisted Gateway handoff notices now have concise localized titles and an attributed,
literal reply. The adapter requires a system author and a durable conversation or run
reference. It recognizes existing Gateway notice forms, never bot-authored protocol-like
prose. Only the exact matching outer bot wrapper is removed from the presentation;
quoted content remains React text, with no HTML execution or entity decoding. Long quoted
results use the existing chat disclosure. Original protocol remains behind Technical
details, and the existing run-details link remains available.

The collaboration link sits in the message content column rather than the narrow avatar
column. A failed or stopped run already represented by its own durable handoff outcome
does not get a second outcome card. Matching uses the exact run ID and status; a failed
supervisor continuation remains visible even when its delegate returned successfully.

Actual run errors keep their failure status and show a brief explanation. Existing known
server reasons remain specific; the observed unavailable-model error gets a localized
explanation. Full original error text and stack remain behind Technical details. Unknown
errors use a general failure explanation rather than an invented cause.

Background thread-message activity is labelled Bot collaboration; actual scheduled work
keeps its existing label. All new copy is present in the five existing locales under their
current translation-review policy.

## Verification and limitations

Focused tests cover trusted-notice recognition, rejected bot/human impersonation,
malformed envelopes, literal script-like text, the original-text disclosure, failed,
stopped, silent and forwarded outcomes, exact-run deduplication, preservation of a separate
supervisor failure, compact errors, conversation links, and collaboration attribution.

The final local gate passed: typecheck, lint (2,460 files), documentation consistency,
884 T0/T1 test files with 8,309 tests, and the web production build. The focused subset
passed 40 tests across four files. The production build retains its existing chunk-size
advisory. No Docker T2 or new real-model T3 campaign was run for this frontend change.

A local browser replay used the captured real-model messages and run outcomes with the
production chat components. It confirmed that the result and genuine failure remain
distinct, protocol and stack are collapsed by default, the collaboration link has usable
width, and opening Technical details reveals the original error. This is a local replay,
not a new live-model acceptance or a stable deployment. The replay fixture and screenshots
remain in the private acceptance evidence rather than the public source tree.

The unavailable fallback is not repaired by this UI change. Global model configuration was
not changed. No claim is made that the original source-chat continuation completed.

The owner's subsequent same-day request adds a quieter Use history projection and actual-width
sidebar states. The final policy and 8,318-test gate supersede the initial presentation defaults
above; see [Everyday chat state and navigation](use-view-state-and-navigation-2026-10-22.md).
Tune still preserves original protocol and errors, and unrelated success still does not resolve
a current supervisor failure.
