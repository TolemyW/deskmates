# Actual action-row alignment — 2026-10-28

Before production CSS changes, new browser assertions failed on the Files header
row: a 12px bottom margin on the Shared apps wrapper displaced actual button
centers by 6px. The upload/help group also had a 6px gap, below the declared 8px.
`before.json` retains the red run. Removing that wrapper margin and making the
upload group gap 8px fixes the actual control geometry without changing native
button sizes.

`after.json`: 360 Files layout states, zero failures, rowDetectorVerified=true.
The gate restores the old margin and separately makes a button 8px taller; both
negative controls must fail their corresponding alignment/height assertions.
The focused run intentionally does not execute the unrelated Contacts tab control.
Checks cover five languages, two themes and 390/600/720/1280px real viewports.

The shared browser evaluator scans marked rows and measures nested controls, with
1px center/height tolerance. Small help buttons share the center but are excluded
from equal-height comparison. Minimum spacing applies to all controls on a line.
New rows need markers and a feature fixture; unmarked pages are not certified.

Run `npm run check:layout -w packages/web`, or set TAB_LAYOUT_FEATURES=files for
focused work. The existing CI layout step runs the same code and saves failures.
Typecheck, lint, docs checks, 18 affected interaction tests and web build passed.
No commit, deployment or remote CI execution was performed.
