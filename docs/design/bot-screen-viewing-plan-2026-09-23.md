# Watching bot screens in a shared workspace

Date: 2026-09-23; updated 2026-09-24.
Status: superseded planning history; implementation follows accepted ADR-0008.

The operator clarified that all bots must share one working environment and
**one login automatically**, while the UI previews and opens their individual
screens. Separate workspace containers or per-bot browser profiles do not meet
that requirement.

[ADR-0008](../adr/0008-per-bot-desktops-in-a-shared-workspace.md) retains one
Chromium/profile and X display, with six bot window regions and server-enforced
read-only previews through the operator origin. Manual takeover pauses browser
work across the workspace. The implementation and concrete evidence are recorded
in [the results](bot-desktops-ui-results-2026-09-24.md).

## Historical proposal — not the current implementation

The material below records the earlier diagnosis and proposals. In particular,
per-bot workspaces, direct internal-container port publication and URL-based
view credentials are superseded by ADR-0008. It is retained for context only.

## The requirement, in the operator's words

Each bot has its own thread and its own screen window. Clicking it at any time shows the
full desktop that bot is working on, live, without interrupting it. Work a bot does with no
graphics — a background shell script — is explicitly out of scope and needs no view.

Two things follow from that wording and were confirmed with the operator:

- The wanted view is the **whole screen**, not a browser tab. A per-tab CDP screencast was
  proposed and rejected: it shows one page, and the operator wants what the machine shows.
- The operator accepts a reduction in workspace network isolation to get it.

## Why this is three separate pieces of work

### 1. One screen per bot is a grouping decision, not new code

A workspace owns one Chromium and one X display (ADR-0004; AGENTS.md "One Chromium per
workspace"), so bots that share a workspace share one screen and would all show the same
picture. One bot per workspace gives each its own desktop. ADR-0004 already says isolation
escalates by workspace and never by bot, so this needs no mechanism — it is a supported
grouping, available today.

It is not free, and the cost must be written wherever an operator picks it:

| | Bots share a workspace (today's default) | One bot per workspace |
| --- | --- | --- |
| Screens | one, shared | one per bot |
| Containers | one | one per bot (Chromium + Xvfb, 4 GiB ceiling each) |
| Login | a human logs in once, the whole group is covered | every bot logs in separately, MFA included |
| Files and cookies | shared by design | separate |

The shared-login property is the one B2's acceptance exercises and it is the main thing
per-bot workspaces give up. Worth keeping as the default for bots that work in one system;
worth trading away for bots that each own a different site.

### 2. A view-only screen, separate from takeover — the real gap

Today the only route that yields a screen is `POST /api/workspaces/:id/takeover`, which
acquires the workspace browser lock and makes every bot in that workspace wait. Watching a
bot must not stop it, so this needs its own path.

The image already supports it. `images/workspace/entry.sh` starts x11vnc with `-shared`, so
additional clients may attach, and x11vnc takes a second, view-only password via
`-viewpasswd`. The plan:

- Generate a view-only password beside `DESKMATES_VNC_PASSWORD` at container start.
- Add an authenticated operator route that returns it and **does not touch the browser lock**.
- Build the URL with `view_only=1` alongside the existing `autoconnect=1&resize=scale` in
  `novncUrl` (`packages/contracts/src/sandbox.ts`).
- Leave the takeover path exactly as it is, for when the human wants control.

The view password inherits every rule ADR-0006 decision 4 sets for the control password:
memory only, never in the database, never in an ordinary registry response, never in a URL
query parameter. Those four hold for the control password today — verified 2026-09-23 by a
full-table scan of the Gateway database and by reading the registry responses — and the same
assertions should cover the new one.

### 3. Publishing 6080 is the blocker, and it narrows B4

B4 puts the workspace on an internal Docker network. Docker gives such a container no host
port mapping at all, so `novncAddress` is undefined and the operator API returns
`novncUrl: null`. Observed directly on 2026-09-23: takeover returns 200 with a held lock and
a null screen.

The operator has accepted the isolation cost, so the narrow fix is to publish 6080 bound to
the host's `127.0.0.1`, as ADR-0006 decision 4 already describes, and to leave every other
internal-network restriction in place. This makes ADR-0006's isolation claim conditional and
therefore needs an amendment that states the exception and its cost plainly: anything that
can reach the host's loopback can reach the noVNC port, and the password is the only thing in
front of it. After this, the workspace must not be described as network-isolated without
naming the exception.

An alternative exists and was proposed during testing: publish the port on the egress proxy
container, which already straddles both networks, and forward to the workspace over the
internal network. It keeps the workspace internal-only. It is more work and it is a design
decision of its own; either way the ADR is amended before code is written.

## The test that hid this

`packages/sandbox-docker`'s T1 uses a fake Docker that accepts a port binding on an internal
network. The real daemon does not. The suite was green while the feature could not work at
all. Whatever publishing design is chosen needs a T2 against the real daemon that fails when
no host port exists — asserting that `novncUrl` is non-null and the page answers 200, not
that a binding was requested.

This is the fourth defect of this shape in the project: a test exercising a path the product
never takes. The earlier three were the zod stdin schema dropping fields, the `lock` versus
`browserLock` mismatch, and `screenshotDir` not reaching the MCP proxy.

## Sequence

1. Amend ADR-0006 with the publishing exception and its cost. No code before this.
2. Publish 6080 on host loopback; add the real-daemon T2 that fails without a host port.
3. Add the view-only password, its unlocked operator route, and `view_only=1`.
4. Document the grouping trade-off where an operator chooses one bot per workspace.

Steps 1 and 2 are also what unblocks WEB-06's noVNC handshake and password checks, which are
recorded as blocked in the Web interaction results.
