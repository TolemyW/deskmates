# spikes/openconnector

Throwaway probe of OpenConnector (oomol-lab, Apache-2.0), the integration runtime ADR-0013 proposes. It answers the five spike questions of that ADR with running code. Results: `docs/design/openconnector-spike-2026-09-29.md`. Nothing here is imported by `packages/`.

No model is called. No real provider is reached: the runtime runs on a Docker `--internal` network with no route off the host, and the only credentialed provider is a local mock Gitea.

## What runs

| Container | Image | Role |
|---|---|---|
| `oc-spike-netns` | `alpine:3.20` | holds the network namespace; network alias `oc-spike-runtime` |
| `oc-spike-capture` | `oc-spike-tcpdump:local` (alpine + tcpdump, built by `up.sh`) | `tcpdump -i any` in that namespace from before the runtime starts |
| `oc-spike-runtime` | `ghcr.io/oomol-lab/open-connector@sha256:55b1c424b454451d61e34ea6e2f540e625569d8f4c31cc4c5ec8052dadda4c9b` (`v1.7.0` = `latest` on 2026-09-29, revision `4505aed0`) | the runtime, SQLite state on volume `oc-spike-data` |
| `oc-spike-mock` | `node:22-alpine` | `mock-gitea.mjs`, alias `gitea.spike.internal` |
| (per run, `--rm`) | `node:22-alpine` | `probe.mjs` then `measure.mjs` |

All names start with `oc-spike-`, never `deskmates-`.

Runtime environment (set in `up.sh`; the two secrets are random per run, kept in `/tmp/oc-spike-secrets.env` and deleted by `down.sh`):

```
OOMOL_CONNECT_ENCRYPTION_KEY=<openssl rand -base64 32>
OOMOL_CONNECT_ADMIN_TOKEN=<openssl rand -hex 24>
OOMOL_CONNECT_ORIGIN=https://deskmates-gateway.example.test/integration-runtime
OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true        # only so the mock on 172.x is reachable
OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=slack,googledrive
OOMOL_CONNECT_BLOCKED_PROXIES=*
OOMOL_CONNECT_LOG_LEVEL=debug
```

`OOMOL_CONNECT_ORIGIN` carries a path, which the runtime treats as a mount prefix: every request goes to `http://oc-spike-runtime:3000/integration-runtime/...`. That is the shape a Gateway reverse proxy would use.

## Run

```
sh spikes/openconnector/run.sh       # up, probe + measure, down, capture summary; about 30 s
```

or step by step: `up.sh`, `probe.sh`, `down.sh`, `pcap-summary.sh`. `down.sh` saves the runtime and mock logs, then removes every container, the network and the volume; images stay.

## Files

| File | What |
|---|---|
| `env.sh` | names, pinned image digest, origin |
| `up.sh` / `down.sh` / `run.sh` | lifecycle |
| `mock-gitea.mjs` | `node:http` stand-in for Gitea: `GET /api/v1/user`, `GET /api/v1/user/repos`; logs every request with its `Authorization` header |
| `mcp-client.mjs` | minimal JSON-RPC client for the stateless Streamable HTTP `/mcp` endpoint, `fetch` only, no SDK; parses the one-event SSE body v1.7.0 returns |
| `probe.mjs` | admin API, runtime tokens, MCP calls; writes `out/01..07-*.json` and `out/guide-*.md` |
| `measure.mjs` | question 1: character counts and token estimates, `out/token-cost.{json,md}` |
| `pcap-summary.sh` (+ `.inner.sh`) | DNS questions and TCP SYNs from the capture, `out/pcap-summary.txt` |

## Outputs (`out/`, from the recorded run of 2026-09-29 11:50 UTC)

| File | Contents |
|---|---|
| `image.json`, `runtime-env.json` | image digest and labels; runtime env with the two secrets redacted |
| `01-surface.json` | health, auth defaults (admin API without token, `/mcp` before and after a runtime token exists), catalog size |
| `02-scope.json` | question 2: named connections, name charset, `comment`, per-workspace runtime tokens with `allowedConnections`, cross-workspace refusals, action allowlist on a token |
| `03-mcp-enumeration.json` | `initialize`, `tools/list`, `list_apps`, `search_actions` request/response pairs (the unfiltered `list_apps` is kept as size + first three entries) |
| `04-action-guides.json`, `guide-*.md` | `get_action_guide` for five Slack, five Google Drive and two destructive actions |
| `05-execute.json` | question 4: `gitea.list_my_repositories` through MCP and `/v1`, error shapes, `/api/runs` audit records |
| `06-oauth.json` | question 3: OAuth config listing, provider setup, authorization URLs built with placeholder client ids, callback behaviour |
| `07-operation-types.json` | `operationType` and description of every Slack and Google Drive action |
| `token-cost.md` | the question 1 table |
| `runtime.log`, `mock-gitea.log`, `pcap-summary.txt` | what the runtime logged, what the mock received, what the runtime's namespace sent |

`out/runtime-netns.pcap` is not committed (see `.gitignore`): it holds the run's throwaway tokens in cleartext HTTP. Rerun to regenerate it.

Recorded tokens are truncated to a prefix; client ids and secrets in `06-oauth.json` are the literal strings `PLACEHOLDER_...`.
