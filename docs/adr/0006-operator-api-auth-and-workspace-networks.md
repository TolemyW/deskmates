# ADR-0006: The operator API is authenticated, and every workspace has its own network

Date: 2026-09-21
Status: Implementation in progress (B4 activated 2026-09-23; amendment 1 of 2026-09-23 adds decisions 6 and 7; amendment 2 of 2026-09-29 adds decision 8; amendment 3 of 2026-09-29 adds decision 9); acceptance pending
Source: M0 code review, 2026-09-21; amends ADR-0004 decision 5 and the sandbox-docker README

## Activation note (2026-09-23)

The user authorized B4 alongside B5. Implement the decisions below together in an
isolated development branch; the old deployment remains unchanged. Targeted unit
checks belong to development, while Docker/network and configured-model acceptance
are handed off separately. See the [parallel plan](../design/m2-b4-b5-parallel-plan-2026-09-23.md).
No trust-domain isolation claim is made before those checks pass.

## Historical deferral note (2026-09-22)

Deferred at M1 planning: functionality first. Revisit when a second workspace exists or when the Gateway leaves the machine that runs the workspaces. Until then the operator API stays unauthenticated and all workspaces share the daemon's default bridge network, which AGENTS.md states in its egress rule.

Accepted consequence: once the approval UI exists (M1 batch 1), an unauthenticated operator API means a bot with a shell can call the decide route and approve its own L2 action. This is accepted for now; the approval ledger records the decider, so such an approval is visible after the fact, not prevented. The M1 items that touch the same code (publishing noVNC on `127.0.0.1`, the workspace egress allowlist) do not implement any decision below.

## Context

Two findings from the M0 review change what the docs currently claim about the security boundary.

**The operator API is reachable, unauthenticated, from inside every workspace.** The Gateway serves three route families on one listener: the model proxy (`/v1/*`), the sidecar routes (`/internal/runs/:id/*`) and the operator API (`/api/*`, plus the SSE feed the web UI uses). The first two must be reachable from every workspace container, which is why `main()` binds `0.0.0.0` and `GATEWAY_BASE_URL` points at `host.docker.internal`. The third has no authentication of any kind. A workspace is the model's trust domain (ADR-0004: nothing inside it is hidden from its bots, including the run token in the SDK process environment), and the bot has a shell. So a prompt-injected bot can read every workspace's `thinking` and tool events, post into any thread as a human (relay count 0, outside the M2 caps) and wake bots that hold production credentials, or create a workspace with an open egress allowlist. The tool-level egress guard does not stop this: it inspects browser navigation and `curl`/`wget`, and the M1 network-level egress cannot stop it either, because the Gateway port must stay reachable for the proxy.

**Workspaces can reach each other.** `DockerProvider.create` sets no `NetworkMode`, so every workspace lands on the daemon's default bridge with inter-container communication on. Inside the image, websockify listens on `0.0.0.0:6080` and x11vnc runs with `-nopw`. Verified on this machine: a sibling container fetched another workspace's `vnc.html`. A bot in workspace B that browses untrusted sites can take the mouse and keyboard of workspace A's logged-in Chromium. ADR-0004 defines "fully isolated" as four assertions between workspaces, the fourth being "A's network namespace is not reachable from B"; that assertion is false today, and the sandbox-docker README until this review claimed noVNC was published on loopback only.

Neither is an M0 gap the docs already record, so both need a decision before code.

## Decision

1. **Every operator route requires an operator credential.** `/api/*` and `/api/events` accept `Authorization: Bearer <GATEWAY_OPERATOR_TOKEN>` (SSE clients, which cannot set headers from `EventSource`, pass it as `?token=`); everything else on those routes is 401. The token is a required configuration value (`.env`, at least 32 random bytes); the Gateway refuses to start without it. The web UI asks for it once and keeps it in memory for the session. Run tokens are never accepted on operator routes and the operator token is never accepted on `/internal/*` or `/v1/*`: the two credentials are checked by different hooks against different stores, so neither class of caller can reach the other's routes.

2. **The operator listener is separate from the sandbox listener.** The Gateway listens twice: `GATEWAY_PORT` on `GATEWAY_BIND` (default `0.0.0.0`) serves only `/v1/*`, `/internal/*` and `/healthz`; `OPERATOR_PORT` on `OPERATOR_BIND` (default `127.0.0.1`) serves `/api/*`, the SSE feed and the web UI in production. A request for an operator route on the sandbox listener is a 404, not a 401, so nothing in a workspace can even probe the operator surface. Decision 1 still applies on the operator listener: binding to loopback is defence in depth, not the boundary, because a reverse proxy or a non-loopback bind is one config line away.

3. **One workspace, one network.** `DockerProvider.create` creates a user-defined bridge network named `deskmates-net-<workspaceId>` and attaches the container to it and to nothing else; `destroy` removes the network with the container; `attach` reconnects a container whose network is missing. Containers on different user-defined networks cannot reach each other on Docker, which makes ADR-0004's fourth isolation assertion true. The host stays reachable through `host.docker.internal` (`host-gateway`). The network is also the place the M1 egress rules will attach (an egress proxy or `iptables` rules on that network), so this decision is the first step of network-level egress, not a separate object.

4. **noVNC requires a per-workspace password.** x11vnc runs with a password the Gateway generates at container start and passes in the create spec's env (`DESKMATES_VNC_PASSWORD`); websockify keeps serving the noVNC page, and the client must present the password to attach. The Gateway holds the password in memory only and re-reads it from the container's environment on `attach`; it never enters the database. The takeover UI receives it from the operator API (decision 1) when a human takes the screen. Publishing 6080 on the host keeps binding to `127.0.0.1`.

5. **The run token's reach is a documented invariant.** A run token authenticates `/internal/runs/<its run>/*` and the model proxy, nothing else. AGENTS.md gets the rule and the T1 test that proves it (an existing test covers other runs' routes; the operator routes are added).

Sequencing: decisions 3 and 4 go in the first M1 batch with network-level egress, since they share the provider code. Decisions 1, 2 and 5 go in the same batch on the Gateway side, because the web UI and the acceptance stack both change (they must present the operator token) and that is one change, not two.

## Consequences

- ADR-0004 decision 5 keeps its text; its "network namespace" assertion becomes true through decision 3 here and its Verification row now names the T2 test below. The sandbox-docker README's statement that noVNC is loopback-only was corrected in the same review that produced this ADR (commit "sandbox-docker README: noVNC is not loopback-only in M0").
- `.env.example` gains `GATEWAY_OPERATOR_TOKEN`, `GATEWAY_BIND`, `OPERATOR_PORT`, `OPERATOR_BIND`. `acceptance/support/start-stack.ts` and `packages/web` send the operator token. `npm run dev:gateway` generates a token and prints it when `.env` has none, so local work does not need a setup step, but a printed token is not a deployment.
- `docker compose up` on a clean machine (ADR-0004 "goal impact" row) must still pass M0 acceptance: the compose file sets the four variables.
- One more Docker object per workspace (the network) to create, reattach and clean up; the `deskmates.managed` label goes on it too so `docker network ls --filter label=deskmates.managed=true` finds strays.
- The workspace image changes (`entry.sh` reads `DESKMATES_VNC_PASSWORD`), so the image is rebuilt and `workspace-image.container.test.ts` gains the password assertion.
- Design v0.3 has no operator authentication section; when this ADR is accepted the design's §6 (Gateway) gets a one-line note per ADR-0001 item 4.

## Amendment 1 (2026-09-23): noVNC is published through the egress proxy, and a screen can be watched without taking it

### What was found

Decisions 3 and 4 contradict each other on a real daemon. B4 made the workspace network `Internal: true` so the workspace has no route anywhere but the egress proxy and the Gateway. Docker gives a container whose only network is internal no host port mapping at all: the `PortBindings` in the create body are accepted and silently ignored, and `NetworkSettings.Ports` is `{}` after start. So "publishing 6080 on the host keeps binding to `127.0.0.1`" in decision 4 never happened. `SandboxHandle.novncAddress` was always undefined, the operator API returned `novncUrl: null`, and `POST /api/workspaces/:id/takeover` answered 200 with a held lock and no screen. Observed on 2026-09-23 on Docker 28.3.3 (API 1.51, client pinned to 1.41); B4's own results note that no real-Docker run was made.

The T1 that should have caught it uses a fake daemon that accepts the binding, so the suite was green while the feature could not work. The two T2 tests that exercise the real path (`docker-provider.container.test.ts` "publishes the noVNC port on loopback" and `workspace-image.container.test.ts` "publishes noVNC to the Gateway host") were red and are the tests this amendment makes green.

The requirement this serves is wider than takeover and is recorded in `docs/design/bot-screen-viewing-plan-2026-09-23.md`: the operator wants to click a bot and watch its whole desktop live without interrupting it. The only route that yields a screen today takes the workspace browser lock, which stops every bot in the workspace. Decision 7 below adds the watching path.

### Options considered

- **Publish 6080 on the workspace container itself.** Not available. Docker publishes ports only through a non-internal network endpoint. Making the workspace network non-internal, or attaching the workspace to a second bridge, gives the workspace a route to the host and the LAN, which is exactly what decision 3 and B4 removed. The plan's "publish 6080 bound to the host's `127.0.0.1`" is a goal, not a mechanism, and this option cannot reach it.
- **Publish 6080 on the egress proxy container and forward inward.** The proxy already sits on both the workspace network and `deskmates-egress-outbound`. A container with one non-internal endpoint publishes ports normally, and Docker's embedded DNS resolves the workspace container by name on the shared internal network. Verified on 2026-09-23 with an alpine probe on the real daemon: a container created on an internal network, then connected to a bridge before start, gets `6080/tcp -> 127.0.0.1:<ephemeral>`; it resolves the sibling by container name; a relay inside it answers an HTTP GET from the host with the sibling's response; the sibling still cannot open a TCP connection to a public address. Chosen.

### Decisions

6. **The egress proxy publishes noVNC; the workspace publishes nothing.** `DockerProvider.create` gives the workspace container no port bindings at all, whatever `SandboxSpec.ports` lists, and the provider's fake daemon refuses a port binding on a container whose only network is internal, the way the real one does. The egress proxy is created with `6080/tcp` published on `127.0.0.1` with an ephemeral host port, and its image runs a fixed-target TCP relay beside the HTTP proxy: every accepted connection on 6080 is forwarded to `<workspace container name>:6080`, resolved per connection over the workspace network, so the proxy needs no workspace address at create time. The target name is passed in the proxy's environment; it is infrastructure, not policy, and never changes for the life of the workspace. `SandboxHandle.novncAddress` is read from the proxy container's port map on `create` and `attach`; `novncPassword` is still read from the workspace container's environment. `NOVNC_CONTAINER_PORT` and `novncUrl()` in contracts keep their meaning: the address is where the Gateway host reaches the page.

   **What this costs, plainly.** Anything that can reach the host's loopback reaches the noVNC page and its websocket, and the per-workspace password (decision 4) is the only thing in front of it. The egress proxy, which was a path out of the workspace network, is now also a path into it, limited to one target and one port. Neither cost is new relative to the M0/M1 deployment this ADR set out to tighten, but from now on the workspace must not be described as network-isolated without naming this exception. What is preserved: the workspace's own network namespace has no published port and no route to the host beyond the Gateway listener; another workspace, on its own internal network, cannot address the host's loopback and so cannot reach this port; the proxy's HTTP proxy port is still unpublished.

7. **A screen can be watched without taking it.** x11vnc already runs with `-shared` and supports a second, view-only password. The Gateway generates `DESKMATES_VNC_VIEW_PASSWORD` beside `DESKMATES_VNC_PASSWORD` at container start; `entry.sh` stores it with `x11vnc -storepasswd` and passes it as `-viewpasswd`, so a client that presents it sees the screen and cannot inject input. A new authenticated operator route, `POST /api/workspaces/:id/screen`, returns `novncUrl` with `view_only=1` added to the usual query and the view password, and does not read, take, renew or release the browser lock; the takeover route keeps returning the control password and stays exactly as it is. The view password inherits every rule decision 4 sets for the control password: memory only, re-read from the container environment on `attach`, never in the database, never in an ordinary registry response, never in a URL query parameter. Watching is per workspace, because a screen is per workspace (ADR-0004); a bot with its own screen is a bot alone in its workspace, and the cost table for that grouping is in the screen-viewing plan.

### Consequences of the amendment

- `images/egress` gains the relay; the image is rebuilt (`deskmates/egress-proxy:dev`) before the T2 tests below can pass.
- `images/workspace/entry.sh` requires `DESKMATES_VNC_VIEW_PASSWORD` the way it requires the control password; the workspace image is rebuilt.
- The sandbox-docker README's "published only on host loopback" sentence is rewritten to say the proxy publishes it, and the AGENTS.md egress bullet names the exception.
- The web UI's takeover screen keeps working unchanged; a "watch" control that uses the screen route is UI work for the batch that implements decision 7.

## Amendment 2 (2026-09-29): the UI keeps the credential for the tab, not for one page load

Decision 1 says the web UI "keeps it in memory for the session". Implemented as React state, that
session ended at every reload: on the stable trial deployment the owner re-entered the token on
each refresh, which the owner rejected as a cost to testing.

8. **The web UI keeps the operator credential in the tab's `sessionStorage`.** A reload keeps it;
   closing the tab drops it; other tabs never see it. It is never written to `localStorage` or a
   cookie. Disconnect removes it, and so does any 401, including the first request after a reload
   presents a rotated token. The Gateway side of decision 1 is unchanged: every operator route
   still requires the token.

Considered and rejected: turning operator authentication off for the trial. The operator
listener serves the LAN, and a workspace reaches any host port through the reserved host
exception (ADR-0009), so a prompt-injected bot could then drive the operator API. `localStorage`
("remember this browser") is also rejected for now: it outlives the tab and is readable by any
script on the origin for as long as the browser profile exists.

## Amendment 3 (2026-09-29): a credential a person can type

Decision 1 never fixed a length; the Gateway refused anything under 32 bytes, and the stable
deployment's generated credential was 44 characters of base64. The owner types it on every new
tab and on every browser, and rejected it as a cost to testing.

9. **The operator credential may be as short as 8 bytes.** Eight hex digits, the first group of a
   UUID, is the intended form on the trial deployment. That is 32 bits: at a thousand guesses a
   second over HTTP, a bot reaching the operator port through the reserved host exception needs
   weeks on average, and every miss is a 401 in the Gateway log. A deployment that wants more
   sets a longer value; nothing else changes, and every operator route still requires it.

Not done: rate limiting failed operator requests. It would matter only if the credential got
shorter still; record it here if a deployment needs it.

## Amendment 4 (2026-10-05, proposed with ADR-0022 P1): people sign in; no credential in a URL

Status: implemented on the ADR-0022 P1 branch; takes effect when the owner accepts ADR-0022.

ADR-0022 replaces daily token entry with revocable user sessions. Decision 1's browser half
(the UI asks for the operator token, `?token=` on `/api/events`) and amendment 2 (the token in
the tab's sessionStorage) are what it replaces; the listener split (decision 2), run-token
confinement (decision 5) and the noVNC decisions are unchanged.

10. **Browsers authenticate with a session cookie; the operator token is a machine credential
    in a header only.** `/api/*` accepts either an HttpOnly session cookie issued by
    `POST /auth/login` (every unsafe method also needs a same-origin `Origin` and the session's
    CSRF token) or `Authorization: Bearer <GATEWAY_OPERATOR_TOKEN>`. No credential is accepted
    in a URL, `GET /api/events` included. The web UI never sees or stores either secret; the
    SSE feed rides on the cookie. The operator token stays the single-tenant maintenance bridge
    for channel adapters, scripts and the acceptance stack, and must lose tenant access before a
    second tenant exists (ADR-0022 decision 4). Run tokens are still refused on every operator
    route, and neither the cookie nor the operator token is accepted on `/internal/*` or `/v1/*`.

### Verification (amendment 4)

| Item | Means | Test | Metric |
|---|---|---|---|
| 10 | `?token=` is 401 on every route including `/api/events`; the bearer header and a session cookie both work; every unsafe `/api/*` route refuses a cookie without CSRF; the UI stores nothing and its EventSource URL carries no credential | T1 `operator-auth.test.ts` (URL credential), `auth-routes.test.ts` (route walk, cookie/CSRF/Origin, SSE); T0 Web `app-auth.test.tsx`, `events.test.ts`, `client.test.ts`; T2 `m2-boundaries.container.test.ts`; browser check `spikes/m4-p1-browser-session-20261005` | none |

## Verification

| Item | Means | Test | Metric |
|---|---|---|---|
| 1 | every `/api/*` route and `/api/events` return 401 without the operator token and with a valid run token; with the operator token they work; `/internal/*` and `/v1/*` return 401 for the operator token | T1 `operator-auth.test.ts`: every registered route walked from the Fastify route table so a new route cannot be added unauthenticated (§4.2, §6) | none |
| 2 | two listeners; `/api/*` on the sandbox listener is 404; `/v1/*` and `/internal/*` on the operator listener are 404; defaults bind `0.0.0.0` and `127.0.0.1` | T1 two-listener test; T2 from inside a workspace container `curl http://host.docker.internal:<GATEWAY_PORT>/api/threads` is 404 (§6) | none |
| 3 | each workspace container is attached to exactly one network, `deskmates-net-<id>`, labelled `deskmates.managed=true`; a second workspace cannot open a TCP connection to the first's 6080 or 9222; `destroy` removes the network; `attach` restores a missing one | T2 isolation, ADR-0004 item 5's four assertions in one test (§4.4, §6): cookie, file, process, network | none |
| 4 | x11vnc rejects a connection without the password; `docker inspect` of the container shows the password only in `Config.Env`; the Gateway database dump does not contain it; the takeover UI attaches with it | T2 workspace-image (password required, wrong password refused); T1 database dump (§6) | none |
| 5 | a run token is accepted on `/internal/runs/<its run>/*` and `/v1/messages` only | T1 route walk in item 1's test | none |
| sequencing | items 3 and 4 land with network-level egress; items 1, 2 and 5 land in the same batch | reviewer reads the M1 batch plan | none |
| 6 | the workspace container has no port bindings; the egress proxy publishes `6080/tcp` on `127.0.0.1` only; `create` and `attach` both return a non-null `novncAddress`; an HTTP GET to `http://<novncAddress>/vnc.html` from the Gateway host answers 200 with the workspace's page; a second workspace cannot reach that port | T1 `docker-provider.test.ts`: the fake daemon ignores a port binding on an internal-only container and the create body for the workspace carries none, the proxy create carries the loopback binding; T2 `docker-provider.container.test.ts` "publishes the noVNC port on loopback" asserts the non-null address and the 200 through the real daemon, never that a binding was requested; T2 `workspace-image.container.test.ts` "publishes noVNC to the Gateway host"; the cross-workspace assertion joins item 3's isolation test | none |
| 7 | `POST /api/workspaces/:id/screen` returns a `view_only=1` URL and the view password, and the workspace's browser lock is the same before and after; the view password is different from the control password, appears only in `Config.Env` of the container, and is absent from the database dump and from every registry response; x11vnc accepts it for viewing and refuses input from a client that presented it | T1 takeover-routes test (lock unchanged, password rules by the same assertions item 4 uses); T2 workspace-image (entry.sh refuses to start without it; a client authenticated with the view password cannot move the pointer) | none |
| 8 | after Connect the credential is in sessionStorage and nowhere in localStorage; a reload shows the app without the credential screen; Disconnect and a 401 after a reload remove it | T0 packages/web/src/app-auth.test.tsx (three cases) | none |
| 9 | the Gateway refuses to start with a credential under 8 bytes and starts with an 8-hex-digit one | T0 packages/gateway/src/config.test.ts "requires a deployment-grade operator credential" | failed operator requests (401s) in the Gateway log |
