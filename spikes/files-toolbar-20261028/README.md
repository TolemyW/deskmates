# Files toolbar and mobile list — 2026-10-28

The default desktop toolbar combines classification, search, a source-filter
popover and display mode. Classification becomes Select before the row wraps.
Shared apps moved into the heading and opens a dialog; upload help and collection
scope use named HelpTip question controls. Filtering retains a matching result
count; the unfiltered count is no longer repeated above the table.

Mobile files show the filename, then source and time together. Desktop Type stays
in the table; mobile Type is available in details. Duplicate filenames keep their
parent directory; long names use at most two lines in the list. Full paths remain
in the named open-details action and detail view.

Verification:
- Full toolbar matrix: 3,200 states, 20 keyboard checks, zero failures, Contacts
  negative control detected (`toolbar-layout.json`).
- Subsequent focused Files run including mobile list checks: 360 states, zero
  failures (`mobile-layout.json`); this focused run does not run that control.
- Real viewport checks: 390, 600, 720 and 1280px, five languages, light/dark.
- Help hover/activation and Escape, filter popover dismissal, compact row geometry,
  no page overflow, and file-detail open/return were exercised in Chromium.
- Files/app-shares/UI tests: 170 passed; new auxiliary-control tests: 2 passed.
- Root typecheck, lint, docs consistency, UI/web/studio builds passed locally.

`desktop.png`, `mobile.png` and `help.png` show the 5181 fixture preview. No
production calls, deployment, commit or remote CI run was performed.
