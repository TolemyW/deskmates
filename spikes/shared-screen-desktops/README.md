# Shared-login screen validation

No model or production credentials are used. All API credentials and login cookies
in these scripts are disposable test fixtures.

- `probe.sh` / `probe.mjs`: initial two-region X/Chromium feasibility probe.
- `runtime-probe.mjs`: runs inside the workspace image with the pinned MCP and real
  BrowserCoordinator. It checks 12 concurrent clicks per bot, shared cookie state,
  distinct window positions and explicit new-tab routing. The workspace-image T2
  suite invokes it with `SCREEN_PROBE_ONESHOT=1` and tears down its own container.
- `live-preview.ts`: disposable in-memory Gateway on 18093 and a real Docker
  workspace. Defaults to the local overlay probe tag; set `SCREEN_TEST_IMAGE` to
  the full candidate image. Uses `deskmates/egress-proxy:desktops-ui-20260924`.
  SIGTERM/SIGINT removes its containers, network and named volumes.
- `rfb-check.mjs`: actual VNC challenge/response through the Gateway bridge. A
  deliberately input-capable viewer proves the view password is server-enforced;
  control coordinates map to bot B's region, and handback closes the socket.
- `ui-check.mjs`: Playwright visits the candidate UI, opens both live previews,
  takes/returns control, checks mobile overflow and captures screenshots. Set
  `PLAYWRIGHT_MODULE` to an installed Playwright ESM entry and optionally
  `PLAYWRIGHT_EXECUTABLE_PATH` to a local Chromium executable. No production
  Playwright dependency pin is changed by this host-only UI check.

Start Vite with `OPERATOR_PORT=18093 WEB_PORT=15373 npm run dev:web`. Generated
reports/screenshots live in ignored `work-runtime/`. The fixture credential is
`TEST_OPERATOR_TOKEN` in Gateway test-support. Do not use this combined test
listener as a deployment; production uses separate operator and sandbox listeners.

See `docs/design/bot-desktops-ui-results-2026-09-24.md` for observed results and
remaining acceptance limits. An overlay test image is not a clean-build claim.
