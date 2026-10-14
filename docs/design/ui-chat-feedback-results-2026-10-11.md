# Chat feedback verification — 2026-10-11

Scope: the owner's five annotated browser comments about approval text, chat ordering,
private-chat activity, run navigation/order, and workspace-file preview.

## Behavior

- Approval decision echoes use one full-width wrapping grid cell and resolve known bot IDs to
  names. The final fix is in the unlayered `design-refresh.css`: its generic message grid
  previously overrode the older component-layer approval rule.
- Private and group chat rows share recency ordering; pins share their existing durable order.
- One-member chats project the bot's other run records, including group and background work,
  with live status and links. Active work and three recent results are shown, older results
  fold away. Existing handoff run cards are excluded from this projection. No new message,
  model input, task, run, or unread watermark is created by the projection.
- Runs open in a right-side dialog over the mounted originating screen. Closing returns to the
  prior hash with its draft and scroll intact. A route/hash snapshot prevents live re-renders
  from recording a run URL as its own return address. Ledger events remain ascending internally
  for gap recovery and render descending by default; an explicit button changes display order.
  Metadata is collapsed so recent execution is near the top.
- File cards show filename and path. Preview opens a right-side dialog with safe rich Markdown
  and the existing type-specific preview implementations. Closing aborts reads, clears the
  remote-image opt-in, releases preview resources and restores focus.

## Verification

- Root `npm run typecheck`: passed.
- `npx biome check packages/web/src`: passed (187 files).
- `npm test -w @deskmates/web -- --exclude '**/integration-catalog.test.ts' --maxWorkers=2`:
  passed (77 files, 591 tests). With the separately run Node test: 592 tests total.
- `npx vitest run --config ../../vitest.config.ts src/integration-catalog.test.ts --environment node`
  from `packages/web`: passed (1 test). This filesystem test fails under the package's blanket
  jsdom environment because `import.meta.url` is not a file URL there, so it was run separately.
- `DESKMATES_DEMO=1 npm run build -w @deskmates/web`: passed; existing large-chunk advisory remains.
- Real Chromium against a localhost standalone demo: see
  [`capture.mjs`](../../spikes/ui-chat-feedback-20261011/capture.mjs) and
  [`results.json`](../../spikes/ui-chat-feedback-20261011/results.json).
  The script covers 1282 px light, 787 px light, and 390 px dark, with screenshots of approval,
  activity, run and Markdown states. It checks approval bounds and name resolution, activity
  visibility, ascending/descending event display, preserved draft/return route, preview bounds,
  inert Markdown HTML, focus restoration and absence of browser exceptions.

The browser uses the in-browser mock Gateway. A browser-only fetch fixture supplies a long
approval echo and a bounded Markdown range response because the older demo transport omits
range headers. These are synthetic UI checks, not a replay of the production conversation.
The run API/routing is unchanged. No Docker/T2, real-model/T3, release, deployment, or live
server acceptance was performed. Existing unrelated campaign work remains untouched.

Regression rerun after the second set of chat-detail changes: all three viewport
cases still pass; screenshots and hashes refreshed. The later backend summary
feature and its separate limits are documented in `ui-chat-details-results-2026-10-11.md`.
