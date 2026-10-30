# Native desktop tools (ADR-0048)

Native desktop tools: LCU in front of an installed desktop application's computer-use runtime,
registered by the sidecar behind its own `desktop-proxy`. On by default on a workspace image that
declares them, off on any other. The owner's rulings and follow-up answers of 2026-10-17 on issue
#7 decide the shape; see ADR-0048 and its amendment 1 for the decisions and the Verification
tables. No live check has run: the upstream application could not be downloaded or verified where
this was built.

## On by default, off by choice (decision 1, amendment 1 A1)

1. The workspace image must declare the capability: the label `org.deskmates.capabilities`
   lists `desktop-lcu-v1`. Only the optional variant `images/workspace-desktop` does, and it is
   built locally, never published (decision 12). Point `WORKSPACE_IMAGE` at it. On any other image
   the tools stay off and cannot be turned on.
2. On a capable image every workspace and every bot has the tools with no setting at all. The
   Gateway reads the image's labels through the sandbox provider when it starts and whenever the
   setting is read or changed, and asks again at a run start when its answer is more than five
   minutes old. While it cannot tell, a workspace without an explicit setting is treated as off.
3. An Owner or Admin may turn the tools off for the workspace (`PUT
   /api/workspaces/:id/desktop-tools` `{enabled: false}`) or for one bot (`{bots: {"<botId>":
   false}}`), and back on. Turning a workspace on explicitly is refused (`400`,
   `details.reason: "desktop_capability_missing"`) when the image does not declare the capability;
   turning a bot on is refused while its workspace is set off. Turning a workspace off keeps its
   bots' own choices. The view says for the workspace and for each bot whether the state is the
   `default` or a choice (`on`, `off`).

Each change writes one `workspace.desktop_tools_set` audit row with the explicit choices before
and after. `GET` is open to Members.

Giving a bot the tools is a strategy change (AGENTS.md): it is not "better" until a paired
evaluation says so, and that evaluation is pending.

## What a run gets

At attempt 1 the run freezes `desktopTools` (`lcu-v1` or `off`), `desktopLcuVersion`,
`desktopAppVersion` and `desktopToolsVersion: 1` into `runs.config_json`; every later attempt
reads them back, whatever the settings or the image say then. Gateway jobs (reviews, summaries,
probes) always freeze `off`. A frozen `lcu-v1` sends `desktopTools: "lcu-v1"` on the start
request; the sidecar adds the `desktop` MCP server only when the container environment also
declares the capability (`DESKMATES_IMAGE_CAPABILITIES`), and logs `desktop`/`capability_missing`
otherwise. Its fixed guidance then carries the rule for choosing between the browser and the
desktop tools (A2): web content in the browser tools, native windows in `mcp__desktop__js`, never
Chromium through the desktop tools, accessibility actions before raw input.

The model sees `mcp__desktop__js` and `mcp__desktop__js_reset`. In the sidecar's hook:

- **No per-call approvals** (decision 2). Both tools are L1 under every approval mode. The effect
  labels of each `js` body (`read`, `capture`, `a11y`, `input`, `input <phrase>`, `launch`,
  `file`, `network`, `clipboard`, `browser`, `opaque`) and its literal URLs ride on the
  `tool_call` event as `desktopEffects` and `desktopTargets`. They are a keyword scan: what the
  code names, not what ran, and never a security boundary.
- **Hard denies** on literal targets: a private address, an IP literal, `localhost`, the reserved
  host alias or an unreadable URL is denied unless a network profile grants the exact origin; in a
  locked workspace an unlisted public host is denied, never asked. Computed targets go through the
  managed egress proxy, which applies the same denies to resolved addresses.
- **Every denial is recorded** (A4): a `desktop`/`egress_denied` log event with the host, the kind
  (`hard_deny`, `not_in_allowlist`, `unreadable`), the reason and the tool call; never the URL.
  When the Gateway stores it, it appends one `egress.desktop_denied` audit row (actor
  `bot:<id>`, target the host, the run id). The run screen shows and counts the denials in the
  story and the technical log, and the Activity card's opened record counts them.
- **Human hold**: while a human holds the workspace, a desktop call gets the wait message.
- **Shell**: a `Bash` line or one-line terminal write that runs the LCU binary is refused
  (`desktop_shell_refused`) and names the tool to use; it reads the literal line only.

## The shared screen (amendment 1, A3, Proposed)

Xvfb has one pointer and one keyboard focus, so raw input from two bots interleaves; accessibility
calls and captures need neither. The proxy takes a lease for each call from
`POST /internal/runs/:id/desktop-lock` (run token), renews it every two seconds while the call
runs, and releases it at the result; a lease expires 15 seconds after its last renewal.

- `shared` for `js_reset` and for code whose labels are all `read`, `capture` or `a11y`; any
  number of bots hold shared leases at once.
- `exclusive` for everything else, including code the scan cannot place: granted only when no
  other lease is held; while held, no other desktop lease and no browser lock acquire of any run
  is granted (`DESKTOP_INPUT_BLOCKS_BROWSER_MESSAGE`). A waiting exclusive request blocks new
  shared leases; waiting exclusive requests are served in arrival order.
- The proxy waits up to 30 seconds for a contended lease, then answers with the busy message and
  dispatches nothing. A human hold refuses every lease and renewal; a call whose renewal is
  refused or reports a new takeover epoch is interrupted (`desktop_call_interrupted`, logged as
  `desktop`/`call_interrupted`, never retried).

Residual, recorded rather than prevented: a browser call already in flight when an exclusive call
starts, a window an application opens during another bot's exclusive call, and a bot's own shell
(`xdotool`). The lease is a soft distinction between bots, not a boundary (ADR-0004).

## The input record (decision 4, amendment 1 A5)

The variant installs `xinput` and names `stdbuf -oL xinput test-xi2` in
`DESKMATES_DESKTOP_INPUT_RECORDER`. The proxy runs it for its lifetime and, at each call's result,
posts a `desktop`/`input_record` log event with the tool-use id, the lease mode and the counts of
raw key presses, button presses and motion events seen while the call was open: counts only, no
key codes or coordinates. A shared call's counts should be zero.

Desktop text reaches the model wrapped as `<untrusted source="desktop:lcu">`, entity-escaped;
images keep their media type, or become the vision-withholding notice.

## Grouping exception (decision 10)

A workspace with desktop tools enabled may hold a signed-in account and also browse untrusted
sites. This is an owner-accepted exception to the ADR-0010/ADR-0020 rule that an
untrusted-browsing workspace holds no production credentials, limited to desktop workspaces and
lapsing when the tools are turned off. Since the tools are on by default on a capable image, it
applies to every workspace on such an image unless its tools are turned off. The view reports
`groupingException: true` while the tools are on, and the workspace page shows the warning.

## Image variant

`images/workspace-desktop/` holds the Dockerfile and the pins; `scripts/build-workspace-desktop-image.sh`
builds it from local, checksum-verified inputs; `scripts/measure-workspace-desktop.sh` records the
growth, start time and memory ADR-0048 decision 11 asks for. Neither is used by the release
workflow or the stable scripts. The T2 checks are in `acceptance/desktop-tools.container.test.ts`
and skip without Docker or without a locally built variant.
