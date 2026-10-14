# Chat detail layout verification

Date: 2026-10-12. Base: main `8e2c2c1380cd7b58de897b442d965e45fa358fe2`
(includes workspace Trash #83 and compact file rows #84).

All three owner PNG references were materialized through Library with identity metadata,
read and visually inspected in this executor. They remain outside the repository.
All browser screenshots in this change use synthetic demo data.

## Behavior and scope

Inspectable chat information, file previews and run details share an opt-in detail
layout. At 1280px and above the right pane participates in flex layout, without an
overlay, background inertness, focus trap or whole-page scroll lock. The chat rail
remains visible at 220px while details are open; navigation stays user-controlled.
The detail width is 320px minimum, with its maximum reserving room for navigation,
the chat list and a usable chat viewport. Each detail retains its original content
scroll region. Nested details occupy one right column and return to the previous
pane on close. Smaller viewports use the existing modal behavior. Confirmation,
archive and other action dialogs are not opted into nonmodal behavior.

Navigation snaps to a 64px icon stage below 180px and expands at 200px. This
hysteresis avoids boundary jitter. Keyboard expansion and reload restore the saved
expanded width; mobile keeps the existing menu behavior. Chat-list width remains a
separate preference and is only constrained while a detail pane occupies space.

Chat text remains text rather than being uniformly wrapped in bubbles. Quotes,
code, audit records and the composer use existing tokens and boundaries. The
shared chat viewport removes its bottom gradient and gives Jump to latest its own
layout row, so it does not cover status records or the editor. Multi-line input
continues to take actual layout height. Approval decisions, provenance, preview
security, range budgets, file downloads and immutable records are unchanged.

## Reproduction and evidence

Start the real demo with `npm run dev -w packages/web -- --host 127.0.0.1 --port 5199`.
Run `PLAYWRIGHT_MODULE=<installed playwright module> node
spikes/chat-details-layout-20261012/verify.mjs`. Optional PLAYWRIGHT_CHROMIUM selects
the browser and EVIDENCE_DIR selects a separate output directory.

The fixture matrix covers 390/1024/1279/1280/1281/1440px, light/dark themes and both
navigation modes, repeated opening/closing, Escape/focus, retained drafts and hash,
chat editing alongside details, no inert background, and no page overflow. The
additional synthetic file response exercises long bilingual text, code and audit
tables in a nested preview; threshold dragging, keyboard restore, reload, independent
scrolling, short-screen multi-line input and concurrent demo message sending are
asserted. `results.json` and screenshots record the successful run. These are
browser checks of the actual UI with mock data, not live Gateway/model acceptance.

Regression tests cover staged navigation persistence, nonmodal detail interaction,
modal fallback and confirmation isolation. Root typecheck, lint, docs check,
production build, focused and aggregate test outcomes, plus exact-head CI, are
reported in the PR. No merge, deployment or actual user-data change is authorized
or performed by this work.

## Activity surfaces

The private-chat activity section, including its heading and earlier-history
control, is constrained to the same 760px transcript width. It keeps native
keyboard-operable disclosures with an explicit chevron. Activity and incoming
handoff cards reuse existing HeroUI links and the existing run-status tone map;
labels, filtering, SSE refresh, read-state behavior and original/run links remain
unchanged. The old blue side stripe is removed. `BotActivity` already uses the
shared status pill and feed presentation; no data or classification changes were
needed there. Its runtime behavior was not independently acceptance-tested.

Run `activity.mjs` with the same environment as `verify.mjs`. Four desktop/mobile
light/dark checks cover heading/history geometry, keyboard disclosures, 44px link
targets, run-detail navigation/return and preserved drafts. The seeded failed run
retains its exit-137 diagnostic. Screenshots contain demo records only.

## Validation boundaries

- Actual Chromium: 24 layout matrix combinations plus the nested-preview and
  threshold scenario passed; four activity scenarios including failed-card diagnostics passed. Final results
  are in the JSON files.
- Focused detail, handoff, activity and preview suite: 4 files, 21 tests passed.
  Navigation and resize-handle tests also passed in their earlier focused run.
- Root typecheck, lint, docs consistency and production web build passed.
- The first aggregate run had 404 passing files / 2 failing files (4129 passing
  tests / 2 timeouts): unchanged Gateway OIDC start-limit and file-range streaming
  tests hit their five-second limits. The targeted rerun including both files and
  related frontend tests passed all 63 tests. No timeout limits were increased.
- A final aggregate run and exact-head CI are recorded in the PR after completion.

This is browser evidence against the in-memory demo Gateway, not live deployment,
model, container or assistive-technology acceptance. Preview loading/error/security
behavior is covered by the existing focused regression suite; the visual matrix
shows loaded and unavailable previews, not every error state. Trash routes and
lifecycle code are untouched. `app.tsx` shares a file with the merged Trash change,
but its Trash navigation entry and route handling are preserved.

## Independent review follow-up

Review found that repeated ArrowLeft presses could stall at the 200px minimum
expanded width. Keyboard resizing now crosses from that minimum into the icon
stage; pointer 180/200px hysteresis is unchanged. A real ResizeHandle integration
test covers 240 → 224 → 208 → 200 → 64, retained separator focus and ArrowRight
expansion. The actual Chromium threshold scenario also passed repeated ArrowLeft,
ArrowRight, Home and reload, alongside the existing pointer boundary assertions.
Focused navigation/resize/detail regression: 3 files, 6 tests passed.

The final pre-review local aggregate had 405/406 passing files and 4131/4132
passing tests; only the unchanged file-range streaming test hit its five-second
timeout. Its isolated rerun passed all 23 tests (affected test: 2.66 seconds).
Exact-head CI and any post-review aggregate outcome are recorded in the PR.
