# Workspace desktop variant (local only)

The optional image that gives a workspace the native desktop tools, on by default on this image
(ADR-0048 decisions 1 and 11): the content-addressed workspace image plus the pinned LCU release and the pinned upstream
desktop application. **Build it locally for your own use only; never push or publish it.**
Redistributing the upstream application is an open gate (decision 12), so the release workflow and
the stable scripts never build or name this image.

What it adds over the base:

- the upstream application package and LCU, installed from local files checked by SHA-256
  (`pins.env`), with no apt indexes and no fixture packages left behind;
- a D-Bus session bus at `/run/deskmates/dbus-session` for AT-SPI, started by `desktop-entry.sh`
  before the base image's own entry point;
- the label `org.deskmates.capabilities=desktop-lcu-v1` (the Gateway reads it: on this image the
  tools are on by default, and an Owner or Admin can turn them off) and the environment the
  sidecar reads before it registers the `desktop` server (`DESKMATES_IMAGE_CAPABILITIES`,
  `DESKMATES_DESKTOP_LCU_COMMAND`, the versions);
- `xinput`, named in `DESKMATES_DESKTOP_INPUT_RECORDER`: the desktop proxy counts the display's
  raw key, button and motion events per desktop call (counts only, never key codes; ADR-0048
  amendment 1, A5).

It adds no capability, device or user-namespace permission (decision 9). LCU's inner sandbox
needs a user namespace and stays unavailable; LCU's kernel runs as the container account.

## Build

1. Build the base: `scripts/build-workspace-image.sh`.
2. Put `lcu-<version>-linux-x64.tar.gz` and `chatgpt-<version>-amd64.deb` in
   `images/workspace-desktop/inputs/` (git ignored). The retained historical inputs are pinned
   in `pins.env`; verify new inputs before changing those hashes. The build refuses empty checksums.
3. `scripts/build-workspace-desktop-image.sh` prints `deskmates/workspace-desktop:amd64-<hash12>`.
4. Measure it against the base with `scripts/measure-workspace-desktop.sh <base> <desktop>` and
   record the JSON under `docs/design/` before relying on it.
5. Point `WORKSPACE_IMAGE` at the tag. The tools are then on in every workspace; turn them off
   on a workspace's page, for the workspace or for one bot, where they are not wanted.

The build needs the package registry once for the application's Debian dependencies; a running
container downloads nothing.

## Checks

`dockerfile.test.mjs` (T0: pins and checksums, no privilege, the capability label and
environment, the entry chain, never in the release workflow or stable scripts) and
`acceptance/desktop-tools.container.test.ts` (T2, skips without Docker or without a locally built
variant). On 2026-10-19 all ten T2 cases passed on Linux, including Gateway takeover/concurrency,
per-call input counts, a native GTK save with an independent byte oracle, and a kernel request
refused by the managed egress proxy on an internal workspace network.
The verified LCU 0.11.3 entry point takes no `mcp` subcommand. The input reader is line-buffered
`xinput test-xi2` without `--root`; that option returned `BadAccess` on the pinned runtime.

For the native form only, build the test derivative (it is never deployed):

```sh
docker build --build-arg DESKTOP_IMAGE=<desktop-image> \
  -t deskmates/desktop-fixture:local images/workspace-desktop/fixture
DESKMATES_T2_DESKTOP_IMAGE=<desktop-image> DESKMATES_T2_BASE_IMAGE=<base-image> \
  DESKMATES_T2_DESKTOP_FIXTURE_IMAGE=deskmates/desktop-fixture:local \
  EGRESS_PROXY_IMAGE=<egress-image> \
  ./node_modules/.bin/vitest run acceptance/desktop-tools.container.test.ts --maxWorkers=1
```

`DESKMATES_DESKTOP_EVIDENCE_DIR` optionally saves the final native-window screenshot. Measurement
and limits are recorded in `docs/design/desktop-integration-live-acceptance-2026-10-19.md`.
