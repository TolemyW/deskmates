# Shared-login bot screens and UI: implementation results

Date: 2026-09-24
Branch: `codex/desktops-ui-20260923`, based on `3d74c5d`.
Status: development implementation and the checks below are complete; no live M2
milestone acceptance or production rollout is claimed.

## Delivered behavior

A workspace still has one Chromium, one persistent profile, shared files and
shared browser login. Each bot receives a stable one-of-six 1280x800 region on a
3840x1600 desktop. Run windows and explicit new tabs are created in that region
and selected using their exact CDP target ID. Parallel creation cannot adopt a
peer's newly created target. The screen mode and slot are recorded with each run.

The React/Vite workbench uses Tailwind, Radix Dialog/Slot, CVA, Lucide and locally
owned shadcn/ui-style primitives. It includes global navigation, conversation
and desktop rails, a Desktops overview, real live previews and an embedded panel.
Viewing does not acquire control. Take/Resume/Return control use the existing
workspace hold. Closing the panel keeps the hold; Escape while controlling is
left to the remote desktop. Existing approvals, transcripts, drafts and SSE
recovery remain covered by their regression tests.

Desktop traffic follows the operator origin through one-use, origin-bound
WebSocket tickets. Control tickets are also tied to the takeover epoch; pending
and connected access cannot survive handback and a later takeover. Read-only
connections use a distinct server-enforced VNC password. Credentials stay out of
status responses, URLs, the database and the run ledger. The egress container
relays fixed screen destinations through loopback host mappings; the workspace
has no host port bindings. The forward proxy and CDP stay unpublished.

Old images require an explicit update. Screen support requires the image's
`cogbot.desktop.mode=shared-monitors-v1` capability label as well as the selected
mode and all six actual port mappings. Merely injecting environment variables
into an old image cannot make it appear compatible.

## Executed verification

| Check | Observed result |
| --- | --- |
| Backend `npm run typecheck`; web typecheck | Passed |
| `npm run lint`; `git diff --check` | Passed |
| `npm test` (no Docker/model tests) | 116 files, 1304 tests passed |
| Web production build | Passed; main JS about 379 KB (117 KB gzip), lazy noVNC about 182 KB (54 KB gzip) |
| Workspace-image T2 on the full candidate image | 14/14 passed: readiness, capabilities, published relay, one browser/profile, fixed MCP/CLI/SDK versions, concurrent screens, restart, clean destruction |
| DockerProvider T2 on Alpine and candidate egress image | 15/15 passed: actual relay through proxy loopback, no workspace bindings, exec, attach, timeout cleanup, snapshot and volume persistence |
| Pinned MCP + production BrowserCoordinator, no model | Two different windows at x=0 and x=1280; 12 concurrent clicks per bot; cookie set by A read by B; explicit new tab stays at x=1280 |
| Real RFB challenge/response via Gateway | Both regions 1280x800; view credential ignores deliberately sent pointer input; control in region B maps (500,400) to root (1780,400); handback closes control socket |
| Real browser UI | Two live noVNC previews, open, take/return control, conversation navigation; 390px layout has no horizontal overflow; no page errors |

The early overlay-image experiment was followed by a full build from the pinned
Playwright base. Final dedicated tags are `cogbot/workspace:desktops-ui-20260924`
and `cogbot/egress-proxy:desktops-ui-20260924`. Existing `:dev` tags and the user's
active workspaces were not replaced. Test workspaces, volumes and networks are
disposable; no model or production credentials were used.

The real-container test caught an egress PID-1 shutdown delay: Docker waited its
full ten-second stop deadline. Explicit signal handling now closes proxy and
screen sockets. The same workspace destruction check passed in approximately
0.5 seconds without relaxing its nine-second bound.

During repeated full-suite runs, the existing adversarial group-fanout test
intermittently hit its three-second turn-budget wait. Its isolated run passed,
and the final full suite passed. This observation is retained rather than
presented as a new reliability guarantee. The scheduler capacity fixture also
now captures each start's ordinal before awaiting HTTP, so a concurrent run
cannot change which fake process is deliberately held open.

## Reproduction and review

Runtime and UI scripts are in `spikes/shared-screen-desktops/README.md`.
Generated evidence is in its ignored `work-runtime/` directory:
`result.json`, `rfb-result.json`, `ui-result.json`, `desktops.png`,
`conversation.png`, `takeover.png` and `mobile.png`. Those screens show a
synthetic validation workspace, not production agent activity.

```sh
WORKSPACE_IMAGE=cogbot/workspace:desktops-ui-20260924 npm run image:workspace
docker build -f images/egress/Dockerfile -t cogbot/egress-proxy:desktops-ui-20260924 .
WORKSPACE_IMAGE=cogbot/workspace:desktops-ui-20260924 EGRESS_IMAGE=cogbot/egress-proxy:desktops-ui-20260924 COGBOT_SKIP_IMAGE_BUILD=1 npm exec -- vitest run packages/sandbox-docker/src/workspace-image.container.test.ts
EGRESS_IMAGE=cogbot/egress-proxy:desktops-ui-20260924 npm exec -- vitest run packages/sandbox-docker/src/docker-provider.container.test.ts
```

`EGRESS_IMAGE` above is the T2 fixture override. The Gateway deployment variable
is **`EGRESS_PROXY_IMAGE`**. Deploy the Gateway/web code and both candidate images
together. The production reverse proxy must support WebSocket upgrades at
`/api/desktop-stream` on the operator listener. Use the existing workspace
Restart action only after its active/parked-run guard permits conversion. The
named profile/home/work volumes are preserved, so conversion keeps the shared
login and files. No active user workspace was restarted during this work.

## Limits and acceptance still outstanding

These are independent browser window regions on one X desktop, not independent
OS sessions. Human input remains workspace-wide. One bot's two scheduling lanes
can change which of its windows is visible. Native applications, popup windows,
manual window movement/maximization, and OS-level shell input have not received
a universal containment guarantee. Cookies and origin storage share normally;
browser sessionStorage remains tab-specific. The initial limit is six screens
per workspace; it is not a measured capacity optimum.

No model-backed T3/X02/X03 milestone run, strategy paired A/B, sustained six-bot
resource benchmark or general native-application isolation acceptance was run.
The existing direct full-desktop takeover link still uses the legacy static VNC
credential; transport revocation here applies to the new embedded screen path.
See ADR-0008 for the decision and verification matrix.
