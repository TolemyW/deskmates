# Dual-MCP screenshot performance probe

This no-model probe isolates the slow automatic captures observed in the concurrent Flash run
`run_5ac66888d48343819ff21560930d1254`. It does not import or modify product code. Two pinned
`playwright-mcp` processes attach to one headed Chromium, create separate fixed targets, keep the
same focus-emulation sessions as production, and capture both targets for eight rounds.

The three isolated arms are:

1. production focus emulation, with target B made the real foreground before target A is captured;
2. the same setup, but host-authored code verifies A's CDP target and calls `page.bringToFront()`
   immediately before its screenshot;
3. the baseline with Playwright's three normal background switches added only to the disposable
   Chromium entry point.

Pinned source inspection found that Playwright's normal Chromium launch includes all three flags,
while `images/workspace/entry.sh` does not. MCP 0.0.82 implements `browser_take_screenshot` as
`tab.page.screenshot({...tab.actionTimeoutOptions})`, and its default action timeout is 5000ms.
The probe preserves that timeout. Its 7000ms JSON-RPC timer only detects a dead MCP process.

Before every round, target B is brought forward and both tabs remain idle for ten seconds, matching
the order of the observed 10–20 second model turns. Each record contains pre/post CDP target IDs,
exact URL, fixed visible target label, equal round/counter values,
visibility/focus state, MCP error text and monotonic duration. Successful JPEGs are retained with
byte length and SHA-256 provenance. A changed target or page identity fails the run.

After the currently frozen A/B jobs finish, run from the repository root:

```sh
WORKSPACE_IMAGE="$(docker image inspect --format '{{.Id}}' deskmates/workspace:m2-live-inline-closeout-r2-20260923)" \
  bash spikes/m2-browser-capture/run-probe.sh
```

`WORKSPACE_IMAGE` is required and must be a Docker image ID; the script checks it with
`acceptance/support/image-id.mjs` before creating anything.

The script creates a unique container plus profile/work volumes per arm with the production 1 GiB
shared-memory size, dropped capabilities, no-new-privileges and 4096 PID limit, and removes only
those resources. It refuses pre-existing output paths, containers or volumes. Raw results are
written under `spikes/m2-browser-capture/work-<UTC>-<pid>/`; set
`PROBE_OUTPUT_ROOT` to choose another ignored directory. The output includes the exact image ID,
source revision and probe hashes, browser version, Chromium command line, MCP version, per-round
JSON, raw logs and all successful images. A failure still writes `result.json` with all completed
rounds and the bounded error before the container is cleaned up.

Interpretation is intentionally narrow. A bring-to-front win with an unchanged baseline and flags
arm supports adding foreground preparation inside the existing capture fences. A flags-only win
supports aligning manual Chromium startup with Playwright defaults. Neither result authorizes
removing the pre/post target, takeover or epoch fences, increasing the five-second timeout, or
retrying a possibly completed browser action.

## Concurrent bring and capture extension

`concurrent-probe.mjs` keeps two independent MCP sessions active and records wall and monotonic
start/end marks for both screenshot RPCs. Its natural arm releases two verified
`bringToFront()+screenshot` routines on the same host turn. Its pressure arm deterministically
brings one target forward, lets the other target steal foreground, and then releases both verified
screenshot RPCs together; the foreground winner alternates each round. There is no added global
lock, retry or timeout change.

Run the extension independently so the original three-arm evidence remains untouched:

```sh
WORKSPACE_IMAGE="$(docker image inspect --format '{{.Id}}' deskmates/workspace:m2-live-inline-closeout-r2-20260923)" \
  bash spikes/m2-browser-capture/run-concurrent-probe.sh
```
