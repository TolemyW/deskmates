# workspace image

The workspace container: one per group of bots (ADR-0004). One image, one role. Promoted from `spikes/s0/test-c/`.

It is built in two layers (2026-09-28):

| Image | Dockerfile | Holds | Size | Changes when |
| --- | --- | --- | --- | --- |
| `deskmates/workspace-base:<arch>-<hash12>` | `images/workspace-base/Dockerfile` | `mcr.microsoft.com/playwright:v1.58.2-noble` (verified in S0), apt tools, npm globals (SDK, MCP, CLI, node-pty, undici) | ~3.4 GB | a pin or the tool list changes |
| `deskmates/workspace:<arch>-<hash12>` | `images/workspace/Dockerfile` (`FROM ${BASE_IMAGE}`) | contracts + sidecar `dist/`, entry scripts, browser policy | ~0.5 MB on top | every release |

The app layer downloads nothing, so it builds offline in seconds anywhere the base is present; that is what lets a host that cannot reach package registries (Testbox) build each release itself. Its content-addressed tag covers the base's hash.

Build from the repository root (the app Dockerfile copies the built sidecar and contracts; `/.dockerignore` allowlists only those paths and this directory):

```
npm run image:workspace            # scripts/build-workspace-image.sh: base (if missing), then app; also tags :dev
WORKSPACE_IMAGE=deskmates/workspace:v1 npm run image:workspace
NO_BASE_BUILD=1 npm run image:workspace       # fail instead of building a missing base
BASE_IMAGE=sha256:<id> npm run image:workspace  # build the app on a pinned base
```

The script builds `packages/contracts`, `packages/testkit` and `packages/sidecar` first and aborts if the build fails, so it cannot silently bake stale `dist/` output. `SKIP_SIDECAR_BUILD=1` is an explicit opt-out for testing an already-built tree. A cold base build (base pull, apt, npm globals) takes roughly five minutes plus the ~2.5 GB base download; with the base present the app layer takes seconds.

Preinstalled (no `npx` or download at run time, see S0 results):

- Xvfb, fluxbox, x11vnc, noVNC/websockify, xdotool, imagemagick, poppler-utils (`pdfinfo`, `pdftotext`, `pdftoppm` for `image_describe`, ADR-0040)
- Node (from the base image), `playwright@1.58.2`, `@playwright/mcp@0.0.82`, `@playwright/cli@0.1.21`, `@anthropic-ai/claude-agent-sdk@0.3.278`, installed globally. The versions are Dockerfile `ARG`s and must agree with AGENTS.md; `workspace-image.container.test.ts` checks them.
- The matching Linux native SDK package is a required, pinned global dependency. The build resolves its executable from the SDK and runs `--version` offline; optional installation failures cannot produce an image that only fails when the first run starts.
- `undici@7.29.1`, linked into the sidecar runtime for explicit managed-proxy dispatch.
- psql, git, gh, python3, curl
- `packages/contracts` at `/opt/deskmates/contracts`, `packages/sidecar` at `/opt/deskmates/sidecar`, and the exact release Starter Skill pack at `/opt/deskmates/starter-skills`. The Gateway still sends the run's recorded set over the start protocol; the image copy makes the audited release asset available offline and introduces no second discovery path. `/opt/deskmates/node_modules` symlinks `@deskmates/contracts`, the four global packages and `zod` (a sidecar dependency that npm nests under the SDK's global install) so the sidecar's ESM imports resolve (ESM ignores `NODE_PATH`). A new runtime dependency of the sidecar must be added to the global install and symlink list in the Dockerfile; `acceptance/m0-stack.container.test.ts` runs the real sidecar in the image and fails when one is missing.

These are direct package pins. MCP 0.0.82 and CLI 0.1.21 each declare and resolve
their own `playwright` / `playwright-core` driver
`1.64.0-alpha-1789764292000`; the global 1.58.2 package selects the image's
Chromium executable. The workspace T2 version check now inspects these nested
drivers as well as the global packages. A depth-zero package listing alone does
not identify the code executing an MCP or CLI browser call. See
`docs/design/m3-browser-capture-runtime-diagnostic-2026-10-02.md` for the exact
image observation and its limits; the version difference alone does not prove
the cause of the retained screenshot timeout.

Scripts on PATH:

| Script | Purpose |
|---|---|
| `deskmates-entry` | Entry point (`entry.sh`): Xvfb `:99`, fluxbox, password-protected x11vnc on loopback 5900, websockify/noVNC on 6080, then ONE headed Chromium with CDP on loopback, `/profile`, and the managed egress proxy. Waits for CDP, then waits. On SIGTERM it requests acknowledged CDP `Browser.close` to flush the profile, waits for Chromium, and exits 0. A bounded TERM/KILL fallback handles an unavailable or stuck browser within the provider's ten-second stop window; fallback does not promise pending-write durability. |
| `deskmates-sidecar` | Shim: `node /opt/deskmates/sidecar/dist/index.js "$@"`. The Gateway runs `deskmates-sidecar run` through `docker exec` with a JSON `StartRunRequest` on stdin. |
| `deskmates-healthz` | `curl http://127.0.0.1:9222/json/version` and `http://127.0.0.1:6080/vnc.html`; also the image `HEALTHCHECK`. |

Environment set in the image: `DISPLAY=:99`, `DESKMATES_CDP_URL=http://127.0.0.1:9222`, `DESKMATES_ENV_FILE=/run/deskmates/env`, `DESKMATES_SCREEN=1280x720x24`.

Container creation supplies `DESKMATES_VNC_PASSWORD` as exactly eight hexadecimal characters and
`DESKMATES_EGRESS_PROXY`. Classic VNC authentication only uses eight bytes, so other lengths are
rejected instead of silently truncated. The password file lives on `/run/deskmates` tmpfs with mode
0600 and its value is never written to logs. Every bot in the workspace shares it by design.

Per-run secrets (the model base URL and the short-lived token) arrive in the `StartRunRequest` on the sidecar's stdin, never in the container environment or an exec argument. Workspace-constant values may be written by `DockerProvider.injectEnv` as `KEY=VALUE` lines to `/run/deskmates/env` (tmpfs mounted by the provider, mode 0600); the sidecar reads `$DESKMATES_ENV_FILE` at start. It is one file per workspace, so it must never hold a per-run value. Nothing in this image is hidden from the bots in it (ADR-0004).

M0 scope: there is no sidecar supervisor process yet. The design has the sidecar own Chromium, Xvfb, noVNC and a single MCP instance; in M0 `entry.sh` owns the desktop processes and each run starts its own MCP through the SDK. Logs of the desktop processes are in `/tmp/deskmates-logs/`.

MCP and CLI attach exactly as in S0: `--cdp-endpoint http://127.0.0.1:9222 --caps vision`, `playwright-cli attach --cdp=http://127.0.0.1:9222`.
