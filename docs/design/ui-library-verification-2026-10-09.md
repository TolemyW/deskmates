# Owned HeroUI library verification — 2026-10-09

Scope: ADR-0025, `@deskmates/ui` 0.1.0, pinned HeroUI React/styles 3.2.6.
This is local component verification, not milestone visual acceptance or deployment.

## Visual correction

The owner rejected the initial gray/green reskin and supplied the HeroUI homepage
as the reference. Removed the custom control colors, reduced radii, flattened
shadows and typography overrides. The studio now presents native HeroUI controls
in a three-column gallery, with separate chat and foundations examples.
Web's legacy theme variables and tab/card selectors are scoped to avoid overriding
HeroUI. The library retains independent versioning, builds, tests and preview.

## Executed checks

| Check | Result |
| --- | --- |
| Root `npm run typecheck`, including UI and web | Passed |
| Root `npm run lint` | Passed; 936 files |
| `npm test -w @deskmates/ui` | Passed; 8 tests in 2 files |
| `npm test -w @deskmates/web` | Passed; 320 tests in 46 files |
| UI library, standalone studio and web production builds | Passed |
| UI `npm pack --dry-run` after build | Passed; 36 files; no studio/test fixtures |
| Studio browser checks | 10 passed; see linked JSON and replay helper |
| Browser console, fresh studio and web demo tabs | No errors or warnings observed |
| Web task creation using local demo fixtures | Passed; title persisted in the detail view, clean form disabled Save |

The web build retains a Vite warning for a JavaScript chunk above 500 kB
(634.35 kB before gzip, 196.80 kB gzip). This is not a build failure.

Root `npm test` was attempted but interrupted after unrelated listener-based
tests failed with sandbox `listen EPERM` errors. The full repository suite is
therefore **not verified**. No Docker, real-model, remote or deployment checks ran.

## Browser evidence

All interactions used local fixtures, with no live Gateway, agent or external action.
The browser helper covers a labelled switch, keyboard slider, segmented tabs,
light/dark mode, mobile overflow, approval acknowledgement and Enter submission.
Temporary viewport overrides were reset after inspection.

- [Replay helper](../../spikes/ui-library-20261009/verify.mjs)
- [Ten check results](../../spikes/ui-library-20261009/checks.json)
- [Native light gallery](../../spikes/ui-library-20261009/heroui-native-light.jpg)
- [Native dark gallery](../../spikes/ui-library-20261009/heroui-native-dark.jpg)
- [Native mobile gallery](../../spikes/ui-library-20261009/heroui-native-mobile.jpg)
- [Web task form after creation](../../spikes/ui-library-20261009/web-task-native.jpg)

The earlier `components-dark.jpg` and `workbench-mobile-dark.jpg` in the spike
folder are superseded evidence of the rejected reskin, not the accepted direction.
Existing Radix desktop dialogs and remaining page compositions are outside this
initial shared-control migration; no claim of a complete app redesign is made.

## Shared compositions follow-up

After the owner's six-reference comparison and implementation approval, the package
now owns reusable `WorkspaceLayout`, `MetricCard` and decorative `Icon` APIs.
Ordinary buttons default to native neutral tertiary; primary and outlined actions
are explicit (the old `default` alias remains primary for existing callers).
The studio adds a task composition and refines chat/gallery typography and outline
icons. Narrow navigation uses a native dialog instead of removing access to the
sidebar. Chat keeps drafts and sent fixture messages per conversation.

Verification: root typecheck/lint passed; UI 13 tests and web 320 tests passed;
all three production builds passed. The web chunk warning remains (634.93 kB,
196.98 kB gzip). [Nineteen browser checks](../../spikes/ui-library-20261009/composition-checks.json)
passed across desktop, panel and phone sizes, with keyboard focus restoration,
conversation switching, task filtering, status changes and dark theme covered.
[Replay and screenshots](../../spikes/ui-library-20261009/README.md) are retained.
The complete installed Lucide license is distributed alongside HeroUI notices.
These are local component/studio changes, not full application layout migration or
milestone acceptance. No deployment, Docker or real-model checks were performed.

## Composer cutoff correction

The owner's screenshot showed partial approval controls at the transcript cutoff.
The owned `ChatViewport` now supplies an end fade and safe spacing, follows the
latest content only while already at the bottom, and offers a return control while
reading. `MessageComposer` grows from one line to a capped internally scrollable
field. Composer and transcript layout are coordinated before paint so resizing
retains the intended reading/follow state.

[12 browser checks](../../spikes/ui-library-20261009/composer-scroll-checks.json)
passed, including geometric visibility of the approval controls above the fade,
input growth/shrink, preserved reading position and phone/dark rendering. Root
typecheck/lint, UI tests (13), library and studio builds passed. This is local UI
verification; no production layout migration or deployment is implied.
