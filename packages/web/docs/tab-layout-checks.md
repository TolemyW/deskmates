# Tab layout checks

Use `SectionTabs` from `@deskmates/ui` for in-page panels, `TabNavigation` for
addressable routes and `ChoiceGroup` for exclusive filters/display modes. Do not add equal-width grid
cells, truncate labels, or override the owned `gb-tab-*` classes in feature CSS.
`src/tab-components.test.ts` enforces the source boundary in the normal unit suite.

## Automatic geometry gate

Run from the repository root:

```sh
npm exec -w packages/web -- playwright install --only-shell chromium
npm run check:tab-layout -w packages/web
```

Playwright is a pinned web dev dependency; the first command installs its Chromium. As with
`ui-fingerprint.mjs`, set `PLAYWRIGHT_MODULE` to an installed `playwright` or
`playwright-core` module and optionally `PLAYWRIGHT_CHROMIUM` to its executable
when the runtime is provided externally. It starts and stops its own local Vite
server with `demo.html`; no previously running preview, Gateway, credentials,
Docker or model is needed. Requests outside the fixture origin and non-GET network
requests are refused. Do not point the test at a production operator endpoint.

Cases live beside their features as `tab-layout-cases.json` and are discovered by
the runner. Each names a seeded route, container and tab strip. The matrix covers
English, Spanish, Japanese, simplified/traditional Chinese; light/dark; 100%/200%
root font size; container widths 320, 479, 480, 481, 640, 760, 761 and 960px. Each
available in-page tab and choice is selected. Fonts finish loading before measurement. A 320px keyboard check selects the last
tab with End, verifies it scrolls into view, and returns to the first with Home.

Assertions measure actual text `Range` rectangles against each control's padded
bounds, detect overlapping controls, an oversized strip and a selected background that
does not match its control after animation finishes. Internal horizontal
scrolling is allowed; squeezing a label outside its control is not. A negative
control temporarily restores the old four-column grid and must be detected.
This proves the detector is active even after the production defect is fixed.

Failures exit nonzero and write per-case PNGs plus `report.json` under
`/tmp/deskmates-tab-layout` (override with `TAB_LAYOUT_OUTPUT`). This gate checks
geometry, not aesthetic quality, backend authorization or actual browser zoom;
root-font scaling specifically tests text enlargement. Keep a small visual review
for new designs. The existing CI gate runs the geometry command for UI-affecting changes and uploads
failure screenshots/report as a seven-day artifact;
the ordinary jsdom suite cannot measure browser layout and does not replace it.

## Regression evidence

Before changing Tabs, the same padded-text assertion failed on the Bot profile
at container widths 640, 760 and 761px with “Long-term instructions”. At 640px,
the text occupied x=652.89–818.11 while the padded control allowed x=674–797.
The original command exited 1; its report and screenshot are retained under
`spikes/tab-layout-20261028/`. The initial same-width rerun after using the shared
component exited 0. The expanded matrix is the ongoing regression gate.

The expanded matrix passed **1,760 states** and **20 keyboard checks**, with
**zero layout failures** and the negative control detected, using the pinned
Playwright 1.58.2 Chromium headless shell. This covers the five feature-owned cases and every
available in-page tab; route navigation keeps link semantics.

## Selection consistency extension

Costs and Files now supply four additional ChoiceGroup fixtures. The same gate
compares computed control height, font size, line height, radius, vertical padding
and foreground/background across those pages for each locale/theme/font scale
and selected state. It does not require route navigation and panel tabs to have
identical semantics or presentation. The test server disables hot updates, so
concurrent source edits cannot reset the viewport/font fixture mid-measurement.

See [Selection design audit](selection-design-audit.md) for the design requirements,
retired CSS checks and the feature-owned native dropdown migration inventory.

The Files fixture also checks the single-row toolbar budget and collapse order,
help hover/activation and Escape, filter-dialog dismissal, and real viewport
widths 390/600/720/1280px. Mobile assertions cover inline metadata, row height,
page overflow and opening/returning from details. `TAB_LAYOUT_FEATURES=files`
runs only this feature for focused debugging; CI omits it and runs all cases.
A focused run does not execute the Contacts negative control.

`npm run check:layout -w packages/web` is the general alias for the same gate.
Rows marked `data-control-row` are measured at real viewport widths: actual action
heights, center lines (1px tolerance) and minimum gaps, including nested wrappers.
Help icons are excluded from equal-height comparison but must remain centered.
The row detector includes negative controls for the old 12px wrapper margin and a
button made 8px taller. CI already invokes this gate; no manual screenshot review
is needed to detect these geometry violations in the covered fixtures.

## Page action rows and toolbars

`npm run check:layout -w packages/web` runs both selection contracts and
`check:page-rows`. The latter discovers feature-owned `row-layout-cases.json`
fixtures, including navigation steps for settings tabs, detail pages and forms.
It uses the local demo only, at 390, 760 and 1280 CSS pixels, including desktop
dark mode. Each case reloads its fixture so editor state cannot leak between cases.

The runner discovers `*-actions`, `*-toolbar`, `*-controls`, `*-filters` and
explicit `data-control-row` containers. It measures visible controls, excluding
controls owned by nested rows. On each visual line, centers must agree within
1 CSS pixel, peer buttons must have equal height, and controls must not overlap.
Visible overflow also fails. Help icons and Select triggers retain their native
component dimensions; they still participate in center and overlap checks.
Native pressed-state scale animations are excluded from peer-height comparisons;
the default, unpressed state remains checked in the page fixture.

A positive control and deliberately misaligned/unequal-height negative controls
verify that the detector itself works. Reports record every visited state and
observed row; failed states include screenshots. A feature with no multi-control
row can legitimately have empty row coverage; this is not evidence for unvisited
menus or forms. Add explicit steps for each new conditional toolbar, rather than
assuming a route's default screen covers it. Use the feature's fixture file, not
a global list. `ROW_LAYOUT_FEATURES` selects features for local iteration;
CI runs all fixtures. `ROW_LAYOUT_OUTPUT` selects the artifact directory.
