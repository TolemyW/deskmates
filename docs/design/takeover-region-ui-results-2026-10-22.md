# Takeover region UI results — 2026-10-22

## Cause and change

The chat header requested the full workspace takeover display, while bot details previewed a
single bot region (ADR-0008). The full framebuffer includes other bot windows and unused slots.
`DesktopView` also imposed the old 8:5 region ratio on both region and full-desktop streams,
adding letterboxing and shrinking the useful browser content.

The chat header now defaults to the first chat member's region. Both header takeover and
bot-card control use `TakeoverDisplay`: members can be selected in a group, and **Entire
workspace** explicitly opens the full display. An unavailable/stopped/legacy region falls back
to that overview with an explanation, without provisioning or allocating a screen. Status
request errors show retry. Switching targets closes the old stream and ticket.

The workspace-wide lease, authentication and server-side control checks remain as specified by
ADR-0004 and ADR-0008. Selecting a region never implies per-bot human takeover. Existing close
semantics remain documented in the web takeover guide.

`DesktopView` follows the actual framebuffer canvas dimensions and fits its local viewport to
available height. Initial defaults match ADR-0008 amendment 1 (1280×720 region, 3840×1440 overview).
Older/custom dimensions are detected without private noVNC fields or resizing the remote session.
The same sizing applies to read-only previews and details. Strings are present in all five
catalogs; translations remain pending native review.

## Executed checks

- Root `npm run typecheck`, `npm run lint`, `npm run docs:check`, web production build,
  and `git diff --check` passed.
- Full web suite using root configuration (`npx vitest run packages/web`): 246 files,
  1743 tests passed. An earlier `npm test -w packages/web` invocation forced jsdom for every
  file and failed five assertions in two untouched Node-environment tests (filesystem URL
  and `Blob.text`); the root invocation uses each file's intended environment. This change
  does not alter that package script or those tests.

- Focused computer / chat takeover / workspace lock regressions: 9 files, 36 tests passed.
  Includes bot control-mode ticket selection, LAN-origin proxy use, workspace handback,
  SSE release and unmount, explicit overview, switching/closing old targets, custom canvas
  dimensions, legacy fallback without startup, and error retry.
- Local Chromium UI check with actual components and styles and synthetic API/RFB fixtures:
  both entry points show the same 1280×720 region at about 1031×580 CSS pixels in a 1440×1000
  window. Explicit overview fits 3840×1440 at 1050×393.75. Mobile 390×844 and short 1180×600
  have no outer horizontal overflow; canvas and surface dimensions agree within 2 pixels.
  No page errors. Screenshots and machine-readable measurements are in the private lab
  receipt **Takeover region UI verification — 2026-10-22**.

The browser fixture verifies layout, not live VNC protocol behavior or actual window placement.
No production takeover, browser input, container restart or model call was made. No release or
stable deployment was performed for this change.
