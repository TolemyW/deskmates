# Page action-row audit — 2026-10-28

The owner requested a cross-page audit of comparable action rows and toolbars,
with fixes and automated layout regression checks. This builds on the Files
control-row red/green receipt in `../control-row-20261028/`.

## Findings and fixes

- Workspace directory: the global label column layout displaced the role select
  by 14.25 CSS pixels relative to its neighbors. The inline label explicitly uses
  row direction.
- Connections: secondary Guide/Unadopt actions used bare link-buttons alongside
  native buttons (19.5 versus 36/40 pixels). They now use the owned native ghost
  Button. The action container wraps when two controls cannot fit.
- Chat header: member summary and info actions used unrelated button recipes
  (25.5/30 versus 36 pixels). Both now use owned native Button variants; removed
  legacy member-button visual overrides, retaining avatar and layout rules.
- Bot Experience: the embedded search wrapper retained its automatic minimum
  width (309 pixels in a 286-pixel container). It can now shrink with its input.

`before.json` is the first route audit; `expanded-before.json` adds settings and
forms and exposed the narrow Experience overflow. These exploratory reports also
include fixture errors and a false height comparison between Select and Button;
they are not all product defects. The final detector preserves distinct native
Select/help dimensions and native pressed scale, while checking their alignment.

## Durable checks

Feature-owned `row-layout-cases.json` files define routes and interaction steps.
The generic runner discovers rows from semantic layout classes, records observed
controls, and checks center alignment, equal peer-button height, overlap and
visible overflow. Nested rows are measured once. Fixtures reset before each case.
Positive and deliberately broken alignment/height probes verify the detector.
The unified `check:layout` command and UI CI gate run both selection and page-row
checks; CI retains failed-state screenshots and JSON reports.

Coverage includes default pages, Bot and workspace settings tabs, create/edit
forms, file preview and filtering. It does not claim exhaustive coverage of every
runtime-data-dependent menu or permission combination. New conditional rows need
an explicit fixture. See `packages/web/docs/tab-layout-checks.md` for the contract.

## Verification

- Final browser matrix: **172 states passed**, across 43 cases in 17 feature
  directories; `detectorVerified: true`. Full observations are in `after.json`.
- Web and UI tests using each file's declared environment: **273 files, 1,911
  tests passed**. An initial invocation wrongly forced jsdom on Node tests;
  rerunning with the repository's declared environments passed without changing
  those tests.
- Root typecheck, Biome lint, documentation consistency and Web production build
  passed. The existing bundle-size advisory remains.
- Test setup uses an absolute module-relative path, so package-local Vitest
  commands resolve the shared UI shims as well as root commands.
- Repository script/CI guards: **19 files, 265 tests passed**.
