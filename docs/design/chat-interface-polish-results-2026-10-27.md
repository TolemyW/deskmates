# Chat interface polish verification — 2026-10-27

Scope: Deskmates web presentation only, based on the owner's annotated chat screenshots.
No deployment, model call, approval policy, scheduling or ledger change.

## Changes

- Single-bot header no longer repeats the bot name and activity. Group membership remains accessible.
- A single status disclosure combines progress and queued counts; run totals and scoped Stop actions remain inside.
- Completed approvals render one compact receipt, with request facts and raw decision messages available on expansion in Use and Tune.
- Receipt message deep links open both disclosures and preserve the message DOM id.
- Human bubbles omit duplicate human/YOU labels; bot replies omit enclosing card chrome.
- Human timestamps are secondary, revealed on hover/focus and retained on touch devices.

## Verification

- Root `npm run typecheck`: passed. Final web typecheck also passed.
- `npx vitest run packages/web/src`: 251 files, 1770 tests passed.
- Added receipt deep-link regression: 1 file, 1 test passed separately.
- Biome checks on changed source and tests: passed.
- Web production build: passed (existing large-chunk advisory).
- Real browser on the local standalone demo: single chat, pending approval, deny flow,
  compact decided receipt, expand/collapse, group members, per-run details and Stop entry point.
- Desktop at the existing browser size and 390 × 844 viewport inspected. Temporary viewport reset.
- Screenshots: `spikes/chat-polish-20261027/desktop.png`, `mobile.png`, and `group-work-details.png`.

The package's forced-jsdom test invocation initially failed on upload-driver Blob methods;
using the root Vitest configuration with each file's declared environment passed the full web suite.
Tests asserting removed labels were updated to the replacement controls and retained behavior.

The browser exercised mock data only. The deployed server and real conversations were not changed.

## Second pass: layout and visual weight

Owner requested implementation of the screenshot review. The second pass changes
navigation defaults (64px icons, 260px chat list; saved preferences preserved),
reduces approval and composer spacing, moves Always into a secondary menu, keeps
its scope confirmation, and renders prose file references as inline preview links.
Unavailable computer text and the persistent shortcut footer are removed from the
chat header and composer. Known approval-request rail excerpts get a specific
label; unclassified system excerpts retain a generic activity label rather than
exposing raw internal transport text. This does not fetch additional message history.

Browser verification used the local mock demo. Filename preview opens the existing
drawer; More approval options → Always opens the existing editable scope form;
Cancel returns to the card without creating a rule. Desktop and 390 × 844 layouts
were inspected; screenshots are `layout-desktop.png` and `layout-mobile.png` in the
same spike directory. No production action or deployment was performed.

The web suite reported 1768 passing and three obsolete display assertions. Those
assertions were updated for inline filenames and the omitted no-screen placeholder;
the affected chat, takeover, file-preview and approval suites then passed all 95 tests.
Root typecheck and production build passed. Final status-disclosure checks and web
checks are recorded with the local verification logs. The build retains its existing
large-chunk advisory.

## Third pass: reading hierarchy

Group list rows use one group icon, titles may wrap to two lines, and relative time
is secondary. The member control moves into the header's action row. Live connection
text becomes a labelled dot; reconnecting text is preserved. Message timestamps omit
seconds but retain a full local timestamp on hover. Run-detail links appear on
hover/focus (always on touch); Latest reply badges are removed. Approval receipts show
the decision without internal actor or tool ids, which remain in expanded details.
Prose filename links open previews, with downloads in the preview rather than inline.

Actual messages, addressing and ordering remain intact: this pass does not infer a
final result from recency or automatically merge separate collaboration turns.

Browser evidence: `reading-desktop.png` and `reading-mobile.png`. Real local-demo
inspection verified preview opening and the drawer download control. Desktop document
client/scroll sizes matched at 1019 × 1059; phone sizes matched at 390 × 844, so no
outer-document overflow was reproduced. The viewport override was reset afterward.

Root typecheck and the production build passed. The full web suite passed 1769 tests;
two download tests still expected zero preview requests after the workflow changed.
They were updated to assert no additional file fetch for the download itself and
rerun with the receipt regression. Existing upload and preview limits were unchanged.

## Fourth pass: lightweight pending approvals

Pending chat approvals now use a compact border-accented strip. The action and
Allow once / Deny stay together. Technical facts, instruction and raw JSON open
in the shared detail pane rather than expanding the transcript. Close returns
focus to Details. Persistent rules and redirect instructions use the secondary
menu; scope confirmation and the existing decision API remain unchanged.
No Gateway risk classification or approval policy was changed.

Validation on the local demo: desktop and 390x844 mobile screenshots, Details
open/close and focus return, secondary menu contents. No approval was submitted
in this browser pass. Evidence: `spikes/chat-polish-20261027/approval-strip-desktop.png`
and `approval-strip-mobile.png`.

Root typecheck and web production build passed (existing chunk-size advisory).
The full web suite completed with 1766 passing and five catalog-key ordering
failures. Sorted the five translated catalogs, then reran the owning message
fragment suite and approval integration suite: 222 passed. The approval tests
verify details disclosure, allow-once requests, deny confirmation, SSE decisions,
legacy attachments and audit preservation. Final web typecheck passed.
