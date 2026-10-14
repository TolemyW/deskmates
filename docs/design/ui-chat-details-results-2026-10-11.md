# Chat details, panel resizing and approval summary verification

Date: 2026-10-11
Scope: the owner's second five browser annotations. Local implementation; no stable deployment.

## Changes

- Chat information shares the preview/run modal drawer surface, rounded inset,
  overlay, keyboard dismissal and focus restoration. Members are a single list;
  duplicate profile links are removed and removal is behind Manage.
- Navigation, chat-list and drawer edges support pointer and keyboard resizing.
  Widths persist locally. Navigation can collapse to named icons; chat content
  retains a 320px minimum and the list a 220px minimum. At phone widths the existing
  single-column navigation remains, with irrelevant separators hidden.
- Header pin/unpin is removed; the chat-list action retains it. Shared menu glyphs
  are centered in their existing native button surfaces.
- Approval source is initially collapsed, including raw input and decision reason.
  New long tool approvals request an advisory DEFAULT_MODEL summary, using the
  separate tool-free, recorded background job specified in ADR-0028. The approval
  can be decided while that job is queued or running. No historical backfill.

## Verification

- Root `npm run typecheck`: pass (backend, acceptance compilation, UI and web).
- Biome on changed source and the web/UI directories: pass.
- Gateway: 154 files / 1,284 T0/T1 tests pass, including the new end-to-end fake-model
  test for deduplication, default model selection, independent usage and unchanged
  action/instruction/transcript.
- Sidecar: 948 existing/current tests checked; the only sandbox failure was the
  existing localhost-listener proxy test, rerun with socket permission: all 7 pass.
  The additional stdin round-trip test brings the verified total to 949. Final
  targeted presentation, stdin and model-event suite: 94 pass. Presentation query
  tests use the repository fake SDK, never a real model.
- Contracts: 14 files / 188 tests pass.
- UI: 9 files / 22 tests pass. Web: 77 files / 592 tests pass; the existing
  filesystem integration-catalog test passes separately in Node (1 test), because
  the package's blanket jsdom environment cannot read its import.meta URL.
- Demo production build: pass, with the existing Vite chunk-size advisory.
- Real Chromium, local demo fixture: 1282px light, 955px light and 390px dark.
  Drawer bounds, desktop pointer/keyboard resize, persisted width after reload,
  minimum widths, compact icons, centered ellipsis, Manage disclosure, preserved
  draft, focus restoration, collapsed approval details and no page errors pass.
  Synthetic summary text is explicitly supplied by the fixture; these screenshots
  do not demonstrate model quality. Card heights were 288px, 310px and 440px despite
  several thousand characters of original instruction.

The first five annotations were also rerun on the final build: all browser checks
pass at 1282px, 787px and 390px (the earlier fixture and its updated screenshots).

## Evidence and limits

Executable fixture and six screenshots: `spikes/ui-chat-details-20261011/`.
`results.json` holds the browser assertions; `SHA256SUMS` identifies the evidence.
No real model, T2 container, paid evaluation or deployment was performed during verification.
Summary latency/quality remain unverified on the deployed default model. Background
lane occupancy can delay summaries. Existing records show original details, not
an invented or truncated AI summary. Database migration 0054 is required at release.
