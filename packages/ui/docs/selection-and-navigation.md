# Selection and navigation requirements

This is the application contract for choosing and composing selection controls.
It implements ADR-0025's owned-component and native-appearance requirements.
HeroUI remains the visual source; do not introduce a parallel color or size scale.

## Choose by user intent

| User intent | Required owned component | Contract |
| --- | --- | --- |
| Move to another address/page | `TabNavigation` | Real anchors, `aria-current=page`, browser Back/open-in-new-tab; horizontal or documented sidebar layout |
| Switch a section of the same entity | `SectionTabs` | Tab/panel relationships, arrows/Home/End, disabled skipping; declare draft retention when needed |
| Filter a dataset or choose one display mode | `ChoiceGroup` | One controlled value, pressed buttons in a named group; Tab and Enter/Space; no tab-panel claims |
| Choose a value in a form or from a longer list | `Select` | Visible field label where practical; controlled value, empty/disabled/required behavior |
| Independently enable a setting | `Switch` or `Checkbox` | Checked state, not a page tab or mutually exclusive filter |
| Invoke an action | `Button` / `ButtonLink` | Primary for the main action, neutral for secondary actions; never imitate a selected filter |

Examples: Money/Usage, date presets, file types and List/Grid are ChoiceGroup.
Bot Activity/Experience/Instructions are SectionTabs. Account destinations are
TabNavigation. File Source is Select. Similar shapes do not imply identical
semantics, but the same intent must use the same component across pages.

## Visual and layout rules

- Default form, toolbar and page controls use the library's standard density.
  Do not choose a smaller size merely to fit a long label. A future dense variant
  needs a named library API, a concrete use case and its own studio/test fixture.
- Within one component family, control height, typography, selected/unselected
  colors, radius, padding and focus behavior are owned by the component, not the
  page. Icon-only ChoiceGroup uses the same native button height as text choices.
- The application typography adapter is the sole ADR-0025 exception. Consumers
  may place and size the outer layout, but may not restyle internal controls.
- Keep full labels and content-sized choices. Overflow scrolls within the group;
  do not squeeze equal-width cells, truncate labels or change radius at a breakpoint.
- Counts are optional secondary content owned by ChoiceGroup. They do not change
  the accessible choice name or determine selection color.
- Use text with icons by default. Icon-only display-mode choices require a clear
  accessible name. Decorative icons never become the accessible name.
- Label Select fields above their trigger; align neighbouring field triggers at
  the bottom of a toolbar row. Long labels may grow the row, not the control height.
- Preserve visible focus, disabled state and native light/dark tokens. Selection
  must remain programmatically exposed; color alone is insufficient.

## Change requirements

Before adding a control, identify its row in the table. Reuse the owned component.
If no component fits, add a composition to `packages/ui` with values/callbacks;
keep fetching, business status and persistence in web. Add a studio example,
interaction tests and a feature-owned browser fixture for significant layouts.
Document any exception with its reason and migration condition. Existing debt is
not permission to copy the old implementation into a new screen.

The web `tab-components.test.ts` rejects retired selection recipes and direct
owned-class overrides. `styles/selection-policy.test.ts` pins existing native
Select debt per feature; resolved entries must be removed, not reassigned.
`check:tab-layout` tests geometry and cross-page ChoiceGroup styles. These checks
are release requirements for affected code, not a substitute for semantic review.
See the web [audit](../../web/docs/selection-design-audit.md) for current coverage.

## Collection toolbar composition

Put classification, search, extra filters and display mode in one row by default.
Search takes remaining space; optional source filters belong in a named
ControlPopover. Keep context actions in the heading. With less container space,
collapse classification to Select before wrapping the toolbar. At small widths,
search gets the first row and controls the second; very narrow containers with
large text may use a third row to preserve accessible control sizes. Do not shrink
fonts to force a row. Avoid a separate default result count when the All choice
already states it; show matching totals when filtering.

Short optional guidance uses HelpTip beside the relevant label/action, with a
small native ghost question button. Hover or keyboard focus reveals it; activation
also opens it for touch. Escape dismisses it. Do not hide required instructions,
errors, approval consequences or interactive content in a tooltip. Use the native
ControlPopover for interactive fields, preserving focus restoration and Escape.
The Files browser fixture enforces row budgets and classification collapse order.

For mobile file collections, retain file identity first and put source plus time on
one metadata line. Avoid repeating column labels for every item. Type can move to
details when the icon/extension already identifies it; preserve directory context
for duplicate names. Long names may occupy two lines, with the full path available
through the named details action. Desktop keeps the full table columns.

## Actual control-row geometry

Mark a coordinated action row with `data-control-row` and its primary action
buttons with `data-row-control`. Nested wrappers do not define alignment: measure
the actual visible button rectangles. Same-row action heights and vertical centers
must agree within 1 CSS pixel. HelpTip may use its smaller native size but shares
the center line. `data-control-gap` declares the minimum gap (8px for Files heading
actions). Wrapping is allowed; each resulting line is checked independently.
Avoid margins on individual action wrappers; the row owns spacing. Files' browser
fixture injects both the historical wrapper margin and an unequal button height,
and requires both faults to be detected before the gate passes.

## Density across viewport sizes

- Browsing collections use compact rows; full descriptions, configuration and history belong
  in a detail view. Wider viewports add useful columns or a detail pane, not larger controls
  or decorative empty space.
- Group identity with its badges, and status with its related metadata. A field does not
  automatically need a separate row. Keep primary actions reachable without hover.
- Prefer one toolbar row for search, filtering and view selection. Collapse secondary actions
  deliberately when room runs out; never squeeze labels into unreadable columns.
- Put generic explanatory help behind a labelled, keyboard-accessible help control. Errors,
  blockers, approval consequences and required input instructions remain visible.
- Density depends on the content: browsing rows are compact; prose and editing retain reading
  space. Do not use global max-heights or overflow clipping to meet a density budget.
- Preserve native control sizes and focus targets. Reduce redundant wrappers, repeated labels,
  padding and gaps before changing typography or shrinking interactive targets.
- Validate both phone and desktop widths, long names, multiple recipients and consecutive
  messages. Feature-owned fixtures must assert containment and meaningful density budgets,
  and prove the relevant regression fails before the fix.
