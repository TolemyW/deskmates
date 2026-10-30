# Selection design audit — 2026-10-28

Normative requirements: [Selection and navigation](../../ui/docs/selection-and-navigation.md).

## Findings and disposition

| Area | Cause found in code | Disposition |
| --- | --- | --- |
| Costs mode and date presets | Raw buttons with `.period-picker`; independent padding, border and blue active fill | Migrated to owned ChoiceGroup; recipe removed |
| Files type and List/Grid | `.app-tabs` plus feature overrides; two global recipes and mobile-specific padding/radius | Migrated to ChoiceGroup; retired recipes removed |
| Bot sections | Previously equal-width profile grid clipping long labels | Shared SectionTabs; prior red/green evidence retained |
| Account destinations | Separate addresses styled as a local navigation list | Shared TabNavigation, intentional desktop vertical arrangement |
| Form dropdowns | Shared Select coexists with 15 native select elements | Feature-owned `design-exceptions.json` inventory; new instances fail source checks |
| Other filter/mode controls | Activity filters, round mode, preview modes, memory filters and app categories still have local compositions | Follow-up migration to ChoiceGroup; not certified as unified by this change |
| Independent pressed actions | Pinning, member management and info-panel toggles also use `aria-pressed` | Do not mechanically convert these to exclusive choices |

The screenshots supplied for this audit were from the 5179 preview. The working
preview is 5181; the audit inspected source rather than treating an older preview
as evidence that the last Tabs change was missing.

## Enforcement

1. Component choice, standard density and forbidden visual overrides are written
   in the UI requirements and linked from repository guidance.
2. Existing native dropdowns are inventoried beside their owning feature. The
   source test compares actual JSX counts by file with that inventory. A new file
   or added instance fails; resolving an instance also requires deleting its debt
   entry. Do not increase the inventory to silence a failure.
3. Retired `.app-tabs`, `.period-picker` and Files-specific recipes are rejected;
   pages cannot override owned tab/choice CSS classes. This is a source boundary,
   not an inference engine that can recognise every bespoke widget.
4. The browser gate checks full labels, overlap and overflow, plus actual height,
   font size, line height, radius, vertical padding and foreground/background of
   ChoiceGroup controls across Costs and Files for equivalent state/theme/scale.
   Feature fixtures are discovered automatically; add one when adding a pattern.
5. UI tests cover controlled values, disabled choices, names, icon-only controls
   and form submission safety. Existing Costs/Files tests exercise filtering and
   view switching through their unchanged public button semantics.

Run `npm run check:tab-layout -w packages/web` for browser checks; normal Vitest
runs enforce source policy. See [Tab layout checks](tab-layout-checks.md) for the
language, theme and container-size matrix and CI failure artifacts.

This change does not claim every historical selection control is migrated. The
15 native dropdowns and the local filter compositions above remain explicit
follow-up work. Complex mention pickers, workspace menus and avatar palettes need
separate interaction contracts; replacing them with a generic Select would lose
behavior. Semantic review and a small visual review remain necessary for new
patterns; routine geometry and same-family appearance checks are automated.

## Verification

The expanded browser gate passed 4,000 layout states and 20 keyboard checks with
zero failures; the negative control was detected. Web/UI and CI-script tests
passed 274 files / 1,951 tests. Typecheck, lint, documentation checks and web/UI/studio
builds passed locally. Evidence is under `spikes/selection-design-20261028/`.
Remote CI has not run for these uncommitted edits.

## Collection density across viewport sizes

At all viewport sizes, browsing collections use compact rows rather than vertically stacked profile
cards. In Bots, keep the avatar beside identity, default badge beside the name, role at two lines
with the full role available in Profile, then status and actions. Do not hide blocking or approval
status. Omit the generic introductory sentence on phones. Preserve the Chat and Profile targets.
Tasks keep search and the accessible status selector on one row; blocker reasons stay visible.
Files retain compact rows. Skills review requests retain the evidence needed before a decision;
they are not ordinary browsing rows and must not share a blanket height limit.

`check:mobile-density` is part of `check:layout` in CI. It visits Bots, Tasks, Files, Skills and Account at
360, 390, 430, 1280 and 1440px, asserting no page overflow. Fixture-specific budgets are: bot rows at most
180px and first bot above 240px; task filter row at most 48px, task summaries at most 150px;
file summaries at most 140px. These are regression budgets for the seeded content, not CSS max
heights that clip real content. The Bots check failed before the change (246–301px per card).

Density budgets live in each feature’s `density-layout-case.json`; the runner discovers them rather than maintaining a central route list. Desktop Bots use the same compact identity block with actions beside it. Account section padding and spacing are reduced without changing form control sizes.
