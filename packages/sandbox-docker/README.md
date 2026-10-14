# @deskmates/sandbox-docker

Implements `SandboxProvider` from `@deskmates/contracts` with the Docker Engine API.

One sandbox kind: the **workspace** (`images/workspace`). A workspace holds a group of bots that share everything inside it (ADR-0004).

- `/home/<bot>` per bot (SOUL, MEMORY, diary, skills, `.claude/` session transcripts). Plain directories on one filesystem, not isolated volumes. Bots can read each other's.
- `/work` shared working area and scripts.
- `/profile` the single Chromium user data directory for the whole workspace. One Chromium, one cookie jar, shared by every bot in it.
- Its own internal network with HTTP(S) egress restricted to the workspace allowlist by a managed forward proxy.
- noVNC on 6080 (full desktop) and 6081–6086 (bot regions), relayed through the managed egress container and published only on host loopback. The workspace has no host port bindings. Distinct eight-hex control and view-only credentials stay in the in-memory handle; status responses and the database never contain them. See ADR-0008.

Provision a second workspace when work must not share a login or a filesystem. That is the only isolation mechanism; do not add per-bot mounts, per-bot networks or per-bot profiles.

Desktop VM was removed from M3 by design v0.3 amendment C41. A future provider
can implement the same interface; keep Docker specifics out of that interface.

## Files

| File | Concept |
|---|---|
| `docker-provider.ts` | `DockerProvider implements SandboxProvider`, `kind: "docker"` |
| `docker-client.ts` | Eight Engine API calls over `node:http`, including the hijacked exec stream |
| `docker-endpoint.ts` | Where the daemon is: `DOCKER_HOST`, then the docker CLI context, then `/var/run/docker.sock` |
| `docker-stream.ts` | Demultiplexer for the 8-byte-header stdout/stderr framing (T0-tested) |
| `env-file.ts` | Renders and parses the `KEY=VALUE` file `injectEnv` writes (T0-tested) |
| `host-address.ts` | How a container reaches the Gateway on the host |

## Why `node:http` and not dockerode

The provider needs container create/start/stop/delete/inspect/list, exec create/start/inspect, and commit. That is a few hundred lines against a stable, versioned HTTP API (`/v1.41`). dockerode would add a runtime dependency plus `@types/dockerode`, and it does not help with the one non-trivial part, the hijacked exec stream with stdin, which we have to demultiplex and time out ourselves either way. Zero dependencies also keeps the Gateway's supply chain small.

## Finding the daemon

1. `DOCKER_HOST` (`unix:///path`, `tcp://host:port`, or a bare socket path), the same variable the docker CLI honours.
2. The docker CLI's current context: `~/.docker/config.json` → `currentContext` → `~/.docker/contexts/meta/<sha256(name)>/meta.json` → `Endpoints.docker.Host`. This is how colima registers itself on macOS (`~/.colima/default/docker.sock`); no `docker` binary is needed on PATH.
3. `/var/run/docker.sock`.

Pass `endpoint` to the constructor to bypass all three.

A `tcp://` endpoint is assumed to be plain HTTP: `DockerClient` is `node:http` and has nowhere to put a CA or a client certificate. If `DOCKER_TLS_VERIFY` is set, resolution fails immediately with `sandbox_unavailable` / `reason: "tls_unsupported"` rather than connecting in the clear and reporting the daemon as unreachable. Forward the socket locally instead.

## Network and egress shape

`create` provisions an internal bridge named `deskmates-net-<workspaceId>`. The workspace container
is attached to exactly that network. A managed `deskmates-egress-<workspaceId>` proxy joins both the
internal network and the shared provider-owned `deskmates-egress-outbound` bridge. The workspace uses
`127.0.0.1` as its only DNS server and gets the proxy address through `/etc/hosts`. Chromium and
HTTP-aware command-line clients are configured to use the proxy.

The proxy supports plain HTTP port 80 and HTTPS CONNECT port 443. It rejects IP literals,
non-allowlisted names, arbitrary ports, and any name with a loopback, private, link-local, CGNAT,
multicast, metadata or reserved DNS answer. It connects to the checked numeric address, preventing
a second DNS resolution from rebinding the socket. Other protocols are denied. Private enterprise
HTTP services and non-HTTP databases remain unsupported. ADR-0027 adds an operator-owned
exception for exact workspace/hostname/RFC1918 IPv4/443 pairs, with mandatory UTC expiration.
`EGRESS_PRIVATE_TARGETS` is a JSON array of these grants; the hostname must also be an exact
workspace allowlist entry (`*` and suffix wildcards do not grant private access). The proxy pins
the address without DNS, preserves end-to-end TLS verification, and closes tunnels on expiry
or policy revocation. Restart the Gateway and reapply workspace egress after configuration
changes; no bot-facing API can edit the private target setting. Host routing and trusted CA
installation are deployment prerequisites. See `docs/adr/0027-workspace-pinned-private-https-targets.md`.

`updateEgress` writes policy over Docker exec stdin to the proxy's private tmpfs. Reload closes all
existing connections and acknowledges the exact policy hash. If reload fails, the provider stops
the proxy, leaving the internal workspace without a public route. The proxy also switches to
deny-all immediately on a reload error, and a policy generation check invalidates DNS lookups that
were pending when a revocation arrived. No policy endpoint or Docker socket is exposed to the
workspace, and neither container receives `NET_ADMIN`.

The proxy never stores the creation allowlist in its container environment. Every process start
overwrites its runtime policy with deny-all. `create` acknowledges the initial policy before the
workspace starts, while Gateway attach reapplies the current database policy after a daemon
restart. A proxy that restarts while the Gateway remains up stays deny-all until that reapply path
runs; this is a fail-closed availability loss, never rollback to an older permissive policy.

`removeStaleSandbox(workspaceId, image)` is the upgrade path. It compares the `ImageID` of the
workspace container `attach` would pick and of the proxy with what `image` and
`egressProxyImage` resolve to through `GET /images/<ref>/json`. On any difference it removes every
managed workspace and proxy container of that workspace (`v=false`, so volumes stay; the network
stays) and returns the drift; the caller then `create`s. Only the proxy drifting still removes the
pair: the workspace pins the proxy address in `/etc/hosts` and gets its VNC credentials at create,
so one fresh `create` is the only exact rebuild. Both references are resolved before anything is
stopped; a missing one is `image_missing`. Nothing is pulled or built.

`attach` rejects legacy default-bridge containers and extra or mismatched network attachments. It
repairs a missing managed network and starts a missing proxy with an empty policy; the Gateway then
reapplies its persisted allowlist. `destroy` removes the workspace, proxy and workspace network.

`host.docker.internal` remains a deliberate host-service exception so the sidecar can reach the Gateway.
Its requests pass through the managed proxy, which pins an infrastructure-selected host target.
ADR-0006's separate sandbox listener and operator authentication protect that intended path. Other
host services at that target remain reachable and must be secured by the deployment.

## Container shape (`create`)

- Image: `spec.image`. Name: `deskmates-ws-<workspaceId>` (sanitised). Labels `deskmates.workspace=<workspaceId>` and `deskmates.managed=true`; `attach` matches on **both** and prefers a running container, so a leftover exited one never shadows the live workspace.
- `spec.volumes` maps **container path → named volume**, e.g. `{ "/profile": "ws1-profile", "/work": "ws1-work", "/home": "ws1-home" }`. `destroy` stops and removes the container but never the volumes.
- The managed proxy publishes fixed noVNC relay ports on `127.0.0.1` with ephemeral host ports. `handleFor` reads its actual published port map. Region addresses require `DESKMATES_DESKTOP_MODE=shared-monitors-v1` and all six mappings; legacy images do not claim region support. Chromium CDP and the HTTP forward proxy remain unpublished.
- `/dev/shm` is 1 GiB (Chromium; S0 test-c ran with `--shm-size=1g`). `spec.memoryLimitBytes` becomes the cgroup memory limit.
- A 1 MiB tmpfs is mounted at `/run/deskmates` for the injected env file.
- `host.docker.internal` has no workspace `/etc/hosts` entry. The reserved name is sent through the managed proxy. `NO_PROXY` contains only container loopback; the provider pins `egress-proxy` to its workspace-network address.
- Restart policy `unless-stopped`, so the workspace comes back with the daemon — and with its own desktop: `entry.sh` waits on the Chromium process alone and exits non-zero when it dies, so a dead browser recreates the desktop instead of leaving a container that is "running" but permanently unhealthy. The profile is a named volume, so cookies and logins survive. `entry.sh` therefore has to be safe to run twice on the same filesystem; it clears the previous boot's X lock before starting Xvfb.
- `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges"]`, `PidsLimit: 4096`. Nothing in the image needs a Linux capability: Chromium runs `--no-sandbox`, and Xvfb, x11vnc and websockify bind unprivileged ports only. There is no `CapAdd`; if something ever needs one, add it explicitly and say why.
- `sidecarAddress` is `docker-exec://<containerId>`: in M0 there is no sidecar supervisor, the Gateway starts `deskmates-sidecar run` through `exec` and pipes the JSON `StartRunRequest` on stdin.

## Readiness (`create` and `attach`)

`POST /containers/start` returns as soon as the container's init process is running, seconds before Chromium listens on 9222. Both `create` and `attach` therefore poll `GET /containers/{id}/json` until `State.Health.Status` is `healthy`, bounded by the `readyTimeoutMs` constructor option (default 90 s); on timeout the caller gets `sandbox_unavailable` / `reason: "not_ready"`. `State.Health` exists only when the image declares a `HEALTHCHECK`, so an image without one (the `alpine` T2 fixture) returns after a single inspect and nothing waits.

`attach` also repairs what it finds: a stopped container is started, and a running container whose health check says `unhealthy` is restarted. The restart policy only reacts to the init process exiting, so a container that is up with a dead websockify or Xvfb would otherwise stay broken forever.

## `exec`

`POST /containers/{id}/exec` then a hijacked `POST /exec/{id}/start`. `stdin` is written and the write side half-closed, which the process sees as EOF; stdout and stderr are demultiplexed; the exit code comes from `GET /exec/{id}/json`. `env` and `cwd` map to the exec's `Env` and `WorkingDir`. Exec argv and `Env` are visible through the Engine API (`docker inspect` of the exec), so secrets go through `injectEnv`, never through `exec` arguments.

`timeoutMs`: Docker does not kill an exec's process when the client disconnects, so every exec carries a unique `DESKMATES_EXEC_ID` environment marker. On timeout the provider closes the stream, returns `{ timedOut: true, exitCode: -1 }` with the output so far, and runs a second exec that scans `/proc/*/environ` for the marker and `kill -9`s every match, so the whole process tree goes. This needs `/bin/sh`, `tr`, `grep` and `/proc` in the image; alpine and the workspace image have them.

A timeout is the only case where partial output is a result. If the stream ends any other way than cleanly on a frame boundary — a socket error, or bytes left over that do not form a complete frame (`DockerStreamDemuxer.pendingBytes`) — `exec` throws `sandbox_unavailable` / `reason: "stream_error"`. Otherwise `GET /exec/{id}/json` would still report the process's real exit code and truncated output would pass for a complete, successful answer.

## Env injection (`injectEnv`)

Secrets must not appear in the container's create spec, in `docker inspect`, in exec argv or in the host process list. The per-run model credentials (`ANTHROPIC_BASE_URL`, short-lived `ANTHROPIC_AUTH_TOKEN`) therefore travel in the `StartRunRequest` on the sidecar's stdin and are not injected at all. `injectEnv` exists for values that are the same for every run in the workspace: it renders the map as `KEY=VALUE` lines (see `env-file.ts` for the exact format), streams it over exec **stdin** to `sh -c 'umask 077 && cat > /run/deskmates/env.tmp && mv -f ...'`, and the file lands at `/run/deskmates/env`, mode `0600`, on the tmpfs mounted at container creation. Nothing touches the image's writable layer, and the file disappears with the container.

The sidecar reads `$DESKMATES_ENV_FILE` (`/run/deskmates/env` in the image) at start and applies it to its own environment before calling the SDK. It is one file per workspace, so a second injection replaces the first; that is why the Gateway passes the run token in the `StartRunRequest` and does not call `injectEnv` per run. Every process in the workspace can read the file; that is by design (ADR-0004: nothing inside a workspace is hidden from its bots).

## Reaching the Gateway from a container

`gatewayHostForContainer()` returns `host.docker.internal`; `gatewayUrlForContainer("http://127.0.0.1:8080")` rewrites loopback URLs to that host. The Gateway uses it to fill `gatewayBaseUrl` and `modelBaseUrl` in `StartRunRequest`. The proxy resolves its `DESKMATES_HOST_TARGET` once on the outbound network and pins that numeric address. The default target is `host.docker.internal` (the macOS host under Colima). When that default name does not resolve on native Linux, the proxy falls back to the managed outbound bridge gateway. `DESKMATES_HOST_TARGET` is an optional Gateway-process environment variable under operator control; it is never a workspace setting. The Gateway or its fronting service must bind an address reachable from the proxy's outbound network, ordinarily `0.0.0.0`.

## Errors

Every failure crossing the boundary is a `DeskmatesError`: `sandbox_unavailable` for an unreachable daemon, a missing image (`details.reason = "image_missing"`), a name conflict (`"already_exists"`) or any other non-2xx; `not_found` for 404 on an existing handle; `validation` for bad specs.

## Tests

- `*.test.ts` (T0): stream demux including leftover-byte reporting, env-file rendering and parsing, endpoint resolution including the TLS refusal, host address. `docker-provider.test.ts` stubs the three Engine API methods the provider uses, so container selection, the readiness wait and `exec`'s stream failure modes are covered without a daemon. `build-workspace-image.test.ts` runs `scripts/build-workspace-image.sh` with `npm` and `docker` stubbed on PATH. No Docker anywhere.
- `docker-provider.container.test.ts` (T2): the full interface against `alpine:3.20` (`containerCommand: ["sleep","infinity"]` keeps a bare image alive): create (labels, hardening, and no readiness wait because alpine has no health check) → the published noVNC port (bound on `127.0.0.1` per `docker inspect`, and an HTTP GET from the host reaches a stand-in server in the container) → exec with stdin → timeout kill → injectEnv → attach by label from a fresh provider → attach restarts a stopped container → snapshot → destroy keeps the volume → typed errors for a missing image and an unreachable daemon. A second suite makes two local tags from alpine (a tag and a commit, no build or pull) and a committed variant of the egress image, then checks `removeStaleSandbox`: current image kept, new workspace tag recreated with the `/work` volume's content intact, missing image fails closed, proxy-only drift recreates the pair. Skips with a warning when the daemon is unreachable.
- `workspace-image.container.test.ts` (T2, slow): builds `images/workspace` via `scripts/build-workspace-image.sh`, then through `DockerProvider`: `create` returns only once healthz passes, the container runs with no capabilities, noVNC from the host and inside, one Chromium on CDP 9222 with `/profile`, Playwright MCP attach + snapshot over stdio (fixture `src/fixtures/mcp-attach-check.mjs`), `playwright-cli attach`, version pins, tools on PATH, no compiled tests in the image, killing Chromium restarts the container back to healthy, clean stop. Set `DESKMATES_SKIP_IMAGE_BUILD=1` to test an existing tag, and `WORKSPACE_IMAGE` to use a tag of your own.

```
npm test -w packages/sandbox-docker            # T0
npm run test:container -w packages/sandbox-docker   # T2, needs Docker (colima start)
```

## Deferred integration verification

T0 pins create/attach/destroy configuration, fail-closed legacy attach, address policy, VNC setup
and policy reload mechanics without Docker. T2 must still build both images and prove live
cross-workspace isolation, permitted and denied HTTP(S), revocation of an existing tunnel, VNC
password rejection and the Gateway host exception. The golden-site acceptance fixture currently
uses `host.docker.internal` and an ephemeral port. Chromium sends that reserved name through the proxy for
that host, so a successful golden-site run would exercise the host exception, not prove egress
enforcement. A separate external-domain fixture must exercise the proxy; do not weaken the
production policy to fit private/ephemeral-port fixtures. Live reachability remains unverified.
