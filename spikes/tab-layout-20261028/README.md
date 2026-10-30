# Shared Tabs regression receipt — 2026-10-28

Scope: shared in-page Tabs and route navigation in the local fixture demo. No
Gateway, model, production data or deployment was used.

## Red before the fix

The first `packages/web/scripts/check-tab-layout.mjs` checked the original Bot
profile before any production Tabs changes. It exited 1. `before.json` records
text outside the padded control at container widths 640, 760 and 761px;
`before-640.png` captures the first case. The same assertion after the shared
component replacement exited 0 (`after-initial.json`).

## Expanded gate

Run `npm run check:tab-layout -w packages/web` from the repository root. The
runner starts its own fixture Vite server and discovers feature-owned cases.
Final run: Playwright 1.58.2, Chromium headless shell 145.0.7632.6 (v1208), exit 0.
`matrix.json`: 1,760 layout states, 20 keyboard checks, zero failures, negative
control detected. The negative control restores the old equal-width grid and
requires a padded-text violation, so a broken detector cannot silently pass.

An intermediate keyboard assertion sampled before React Aria's animation-frame
scroll and failed one state (`keyboard-before-frame-wait.json`). Inspection of
`react-aria/dist/private/selection/useSelectableCollection.mjs` confirmed focus
reveal is scheduled with `requestAnimationFrame`. The final check waits two
frames before measuring; its visibility bounds were not relaxed.

`after-desktop.png` shows the final native selected pill around the full label.
The preview is at `http://127.0.0.1:5181/demo.html#/contacts/bot_0002`.

## Other checks

- Web, UI and CI-script tests: 272 files, 1,948 tests passed.
- Root typecheck, lint, docs consistency and `git diff --check`: passed.
- Web build, UI library build and UI studio build: passed.
- CI workflow now invokes the layout gate for UI-affecting changes and uploads
  failure screenshots/reports. Remote CI was not run for these uncommitted edits.

Geometry assertions do not certify aesthetic quality or backend behavior. The
font-size matrix tests text enlargement, not browser zoom. Cases and limitations
are documented in `packages/web/docs/tab-layout-checks.md`.
