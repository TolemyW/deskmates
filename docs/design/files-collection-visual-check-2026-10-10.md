# Files collection visual check — 2026-10-10

## Scope

Issue #27 phase B: the workspace Files collection (ADR-0014 amendment A2, proposed) and its screen at `#/resources/files`, with one **Files** entry in the sidebar. The collection lists only paths that the Gateway already references: task artifacts, chat attachments and paths named in bot messages. It is not a filesystem inventory. Phase C (uploads, rendered Markdown and image previews, isolated-origin HTML) is a proposal in ADR-0014 and is not implemented. The Resources sidebar regrouping is separate work and is not part of this check.

No release or deployment was performed. No real workspace, model or tenant data was used.

## Browser verification

Ran `spikes/ui-files-collection-20261010/capture.mjs` with Playwright 1.61.1 and a cached headless Chromium against the standalone demo build (`DESKMATES_DEMO=1 vite build`, served by `vite preview`). The data came from the in-browser mock Gateway. Its `deskmates.demo.files` switch produced the empty, error, loading and stopped-workspace states. `results.json` records the following for each shot: page width against viewport width, theme, active nav entry, row and tile counts, the pager text, the detail panel label, any alert text and page errors.

- **Viewports and themes.** 1116 × 1080 and 390 × 844, in light and dark. No shot scrolled horizontally: `scrollWidth` equalled the viewport width in all 15 shots. No page errors.
- **List and grid.** Both show the 11 demo items, including all four types, one `Unknown` source and two `report.md` files that are told apart by a secondary path. The list columns are Name, Type, Source and Last referenced. Grid tiles use type placeholders and render no file content.
- **Delivery detail.** `/work/kpis.md` shows `Used in delivery` on its task reference only, with links to the task, chat, run and bot. "Accepted" appears nowhere. Size reads "Known after a preview or download reads the file".
- **Unknown provenance.** `vendor-brief.pdf`, attached by a person, shows `Unknown` and the unknown-source note. It also shows the unsupported-preview note, with Download still available.
- **Stopped workspace.** The preview fails with "The workspace is not running … Browsing Files never starts it". The file's metadata stays visible.
- **Filters and states.** The Images filter narrows to one item. The empty, loading and error states render; the error state has a Retry action. No shot shows an upload control.
- **Mobile.** Secondary columns collapse into labelled metadata, type filters wrap, and the detail panel takes the full width with a long file name wrapped.

Two layout fixes came from this review. At 1116 px the detail panel squeezed names character by character, so the detail now sits beside the list only from 1280 px and below the list on narrower screens, where it takes focus. Badges and times also wrapped, so rows now use a compact relative time with the full time in a tooltip.

Screenshots, `results.json`, the capture script and `SHA256SUMS` are in `spikes/ui-files-collection-20261010/`. They are demo screenshots, not production data. Keyboard focus was not inspected visually beyond the T0 focus assertion. Narrow desktop between 721 and 1100 px was not captured.

## Automated verification

- Root typecheck, lint and the documentation consistency check passed.
- Web production build passed, with the existing large-chunk warning.
- `npm test` (T0/T1): 3,683 of 3,685 tests passed on the full run. Two tests in other areas timed out at 5 s under full-suite load: `gateway/src/auth/oidc.test.ts` (SSO-01) and `scripts/stable/stable.test.mjs` (rollback). Both passed when rerun alone (33/33 and 16/16).
- New and changed tests:
  - Gateway `api/file-collection-routes.test.ts`: sources, protected paths, dedup, provenance, unknown, delivery, paging, filters, validation, workspace isolation, no sandbox calls, Member/tenant, scan cap and logging.
  - `operator-auth.test.ts`: a run token gets 401.
  - Contracts `file-collection.test.ts`.
  - Web `screens/files.test.tsx` (9 tests), router, navigation and demo gateway tests.

T2/T3 were not run. Listing does not touch the container, and preview and download reuse the ADR-0014 route already covered by T2. The real-workspace behaviour of the Files screen has not been checked live.
