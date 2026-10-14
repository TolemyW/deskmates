# Dual-MCP click stability probe

Date: 2026-09-23

This probe isolates the concurrent `browser_click` timeout seen in X02/X03. It uses no model,
Gateway, sidecar, golden site, force click, or production changes. Two `playwright-mcp` 0.0.82
processes attach to one headed Chromium and click fixed buttons in separate tabs at the same time.

Image under test:

```text
deskmates/workspace:m2-live-browser-hardening-v2-20260923
sha256:1a14b0a4c7191abdfd875d45f9a4b7a21f3cc8440fa2594f0f170ebcc2047732
Chrome/145.0.7632.0
```

Files:

- `direct-playwright.mjs`: direct Playwright control. Its two pages stay `visible`.
- `dual-mcp.mjs`: the reproducer and focus-emulation control. Set `PROBE_ROUNDS`,
  `PROBE_FOCUS_EMULATION=1`, and optionally `PROBE_FOCUS_KEEP=1`.
- `entry-with-extra-flags.sh`: an exact disposable copy of the image entry point with one
  experiment-only `DESKMATES_EXPERIMENT_CHROME_FLAGS` expansion. It does not modify the image.
- `work-20260923/*.json`: ignored raw output from every arm.

## Results

| arm | rounds | non-current tab | current tab |
|---|---:|---:|---:|
| direct Playwright, production flags | 8 | 8 clicks pass | 8 pass |
| direct Playwright, two extra flags | 8 | 8 pass | 8 pass |
| dual MCP, production flags | 8 | 0 pass; 8 time out | 8 pass |
| dual MCP, `--disable-background-timer-throttling --disable-renderer-backgrounding` | 8 | 0 pass; 8 time out | 8 pass |
| dual MCP, focus emulation then detach | 2 | 0 pass; 2 time out | 2 pass |
| dual MCP, focus emulation session kept open | 8 | 8 pass | 8 pass |

Every failing MCP click resolves the button first, then spends five seconds at:

```text
attempting click action
waiting for element to be visible, enabled and stable
```

The failed tab reports `document.visibilityState === "hidden"`; the peer reports `visible` and
clicks successfully. The two Chromium flags do not alter this. A short-lived external CDP
session sending `Emulation.setFocusEmulationEnabled(true)` also does not alter it because the
override is session-scoped. Keeping that session open makes all 16 clicks in the eight-round
dual-MCP control pass.

## Conclusion

The timeout is caused by the MCP CDP connection omitting Playwright's default focus emulation,
not by the site, locator, or Chromium background-timer launch flags. In the bundled MCP path,
`createCDPBrowser` sets `noDefaults: true`; Playwright therefore skips its usual persistent
`Emulation.setFocusEmulationEnabled(true)` override. The non-current MCP tab becomes hidden and
cannot satisfy normal click actionability's stability wait.

Any production fix should restore focus emulation on the MCP connection's own persistent CDP
session and retain ordinary Playwright actionability. Adding the two tested Chromium flags or
using force click does not fix the cause.

## Reproduction outline

Create a uniquely named container and profile/work volumes from the image above, copy
`entry-with-extra-flags.sh` to `/experiment-entry.sh`, start it as the container command, and copy
one probe to the container. The browser allowlist must contain `localhost` because the entry
point's resolver rules intentionally reject other names. Then run:

```sh
node /direct-playwright.mjs
node /dual-mcp.mjs
PROBE_FOCUS_EMULATION=1 PROBE_ROUNDS=2 node /dual-mcp.mjs
PROBE_FOCUS_EMULATION=1 PROBE_FOCUS_KEEP=1 node /dual-mcp.mjs
```

For the ineffective flags arm, start the disposable entry point with:

```text
DESKMATES_EXPERIMENT_CHROME_FLAGS=--disable-background-timer-throttling --disable-renderer-backgrounding
```
