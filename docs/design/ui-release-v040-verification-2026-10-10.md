# v0.4.0 UI integration verification

Date: 2026-10-10. Implementation: merge commit `9cffcaf` (UI redesign plus main through `68ea390`).
This is an ordinary minor release, not M4 milestone acceptance.

## Changes carried into the release

- Independently versioned `@deskmates/ui` with HeroUI v3, owned Select and Table primitives,
  a standalone studio and shipped upstream license/attribution files.
- Consistent typography, neutral chat surfaces, circular avatars and the owner-supplied logo.
- Safe chat/composer spacing, growing drafts, follow-latest behavior, narrow-screen scroll
  treatment, compact contacts/status layouts and visible dark-mode fields.
- On-demand knowledge editing, costs pagination and consistent table/empty/error surfaces.
- The current main branch's five-language preferences, per-screen guides and first-run checklist
  remain available. New labels have explicit translations in all five catalogs; native-speaker
  review remains pending as documented in `packages/web/src/i18n/TRANSLATIONS.md`.
- The redundant sign-out controls/account popup remain removed as requested. Account editing,
  invitation redesign, separated cost-alert rules and resource navigation remain tracked issues;
  this release does not claim those future features.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed (backend, UI and web) |
| `npm run lint` | Passed |
| `npm run docs:check` | Passed |
| `npm test` | 354 files, 3,641 tests passed |
| `npm test -w @deskmates/web` | 58 files, 405 tests passed |
| `npm test -w @deskmates/ui` | 7 files, 18 tests passed |
| UI package, web production and studio builds | Passed; Vite reports advisory bundle-size warnings |
| Catalog consistency, ICU arguments, hard-coded literals and zh-CN rendering | Passed as part of web tests |
| Live demo browser | English/Chinese switch, Members table, dark Tasks fields, 972px folded navigation and language menu verified |

Browser evidence: [Chinese dark tasks](../../spikes/ui-release-v040-20261010/tasks-zh-dark.png),
[folded navigation language menu](../../spikes/ui-release-v040-20261010/language-narrow.png).
Earlier responsive and component-specific receipts remain in `docs/design/ui-*-2026-10-10.md`.
The browser used the local mock Gateway; this is visual evidence, not real-model acceptance.

The initial root test invocation lacked loopback-listen permission and failed with `listen EPERM`;
it was stopped and rerun with networking permitted. That run found a connector Dockerfile missing
`packages/ui/package.json`; after adding the manifest, the full suite passed. No tests or release
gates were skipped. The T2 deployment receipt is recorded separately after host verification.
