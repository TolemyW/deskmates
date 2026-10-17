# Stable release and deployment on Testbox

Date: 2026-09-28.
Authorization: `AGENTS.md`, "Stable release deployment on Testbox".
Egress policy: [ADR-0010](../adr/0010-open-public-internet-egress.md).

One long-lived Deskmates instance runs on Testbox for internal trial use. It
moves only between tagged releases, and every move can be undone.

## Pipeline

| Step | Where | Command | Gate |
| --- | --- | --- | --- |
| 1. Tag | workstation | `git tag -a vX.Y.Z -m "<notes>" && git push origin main vX.Y.Z` | clean `main` |
| 2. Build | GitHub Actions | `.github/workflows/release.yml` (automatic on the tag) | packaging only, no online test gate (owner decision 2026-10-13; T0/T1 and T2 run on the host in step 5): workspace base built and pushed, app layer smoke-built on it unless the previous published release had the same base digest and none of the app layer's source inputs (`node scripts/image-tag.mjs workspace --source-inputs`) changed since |
| 3. Ship | workstation | `scripts/stable/ship.sh vX.Y.Z` | manifest names the tag's commit and the base by digest and image ID; base transferred only if the host lacks it |
| 4. Install | Testbox | `stable.sh install vX.Y.Z` | `npm ci`, Gateway, release-bundled channel plugin manifest and Web build; source hashes to the manifest's base; app and egress images built offline |
| 5. Verify | Testbox | `stable.sh verify vX.Y.Z` | T0/T1 (`npm test`) in the release directory, then T2 against exactly those image IDs, no model credentials: the smoke subset for a patch tag, the full suite for `vX.Y.0` (`T2_SCOPE=full\|smoke` overrides) |
| 6. Activate | Testbox | `stable.sh activate vX.Y.Z` | no active runs; new release reports its version, else automatic rollback |

`scripts/stable/ship.sh vX.Y.Z --run` does 3 to 6 in one go.
`stable.sh` lives inside each release, at
`~/Data/deskmates-stable/releases/vX.Y.Z/scripts/stable/stable.sh`.

**One command for a patch of `main`.** From the workstation, right after a merge:

```
LOCAL_BASE=1 npm_config_registry=https://registry.npmmirror.com \
  scripts/stable/release-main.sh
```

It tags the tip of `main` as the next patch with notes listing the merged pull requests
(`--dry-run` shows them and tags nothing), waits for the release workflow, then runs
`ship.sh --run`, and prints how long each phase took. A merge to `main` runs no `ci` (to save
GitHub Actions minutes, `ci` runs only on pull requests that are ready for review), so there is
nothing to wait for before tagging: the workflow builds the base and publishes; `stable.sh verify`
on the host runs T0/T1 and then T2 before `activate` accepts the release. A
commit that is already tagged on origin is resumed, not tagged again, so a run that stopped can be
repeated (with `--commit <sha>` once `main` has moved on); a tag that exists only locally because
its push failed is pushed and resumed. A tag whose release workflow fails gets no GitHub release
and ships nothing; fix `main` and release the next patch. The script waits up to 120
minutes for the workflow (`RELEASE_WAIT_MINUTES` overrides), the longest a passing run can take
under the job timeouts; if it gives up, the workflow may still be running, and rerunning the
script with `--commit` resumes the wait. `--no-ship` stops after the workflow; `--version` and
`--commit` override the defaults. `ship.sh --run` passes `LOCAL_BASE` and `npm_config_registry` to `install` on the host.
Pass `LOCAL_BASE=1` to `ship.sh` too when the workstation cannot pull from GHCR: without it,
`ship.sh` retries the pull five times before giving up. A base built on the host downloads its
Ubuntu packages there; set `APT_MIRROR` in the deployment's `.env` to a nearby mirror (the
official archive ran at about 70 KB/s from Testbox on 2026-10-14, 33 minutes for one build).

Measured on 2026-10-12 for v0.5.9 (frontend only), merge to live by hand: `main` ci 5.2 min,
release workflow 3.0 min, ship 0.6 min, install 0.4 min, T2 smoke 0.8 min, activate under 0.1
min, plus about 1.3 min between steps. Since then `main` runs no `ci` and the release workflow
runs the single-job gate itself (about 10 to 11 minutes, estimated from the 2026-10-13 sharded
run's steps) and builds the base only after it passes, so a failing gate spends no builder minutes.
The workflow phase grows by the gate plus the base job (about 2 minutes when the base is unchanged)
while the separate `main` ci phase disappears. Not yet measured.

**Which gate for which release.**

| Release | Tag | Gate before activation |
| --- | --- | --- |
| Patch | `vX.Y.Z`, Z > 0 (`v0.2.14`) | step 2, and step 5 with the T2 **smoke** subset (`acceptance/t2-smoke.list`; 27 s locally with 3 workers, not yet timed on Testbox) |
| Minor | `vX.Y.0` (`v0.3.0`) | step 2, and step 5 with the **full** T2 suite (8 to 9 minutes with 6 workers on Testbox) |
| Minor that completes a milestone | `vX.Y.0` | as a minor, plus that milestone's T3 suite on Testbox in a quiet window, tokens recorded per run |

`verify` reads the scope from the tag; `T2_SCOPE=full` or `T2_SCOPE=smoke`
overrides it (also through `ship.sh --run`), and `t2.json` records the scope
and the exact files that ran. The smoke subset is the stack end to end, each
trigger lane, and every M3 feature that ships to the trial; the rule and the
full-only list with reasons are in
[acceptance/README.md](../../acceptance/README.md). For T3 see also
[measurement needs a quiet host](../design/measurement-2026-09-20.md). T0 to
T2 never need the model endpoint; T3 does, and that endpoint is reachable
only from the internal network, which is why T3 cannot run on GitHub.

**The full T2 suite runs in the background, off the activation path.** Run it
at least once on every day that has a release, and before any minor tag
(where `verify` runs it anyway). It is never on the activation path of a
patch: do not hold a patch activation for it. A failure there stops the
*next* tag until it is fixed or recorded as an exception; it does not undo or
block the activation in progress. And a T2 run never blocks development: start
it in the background and keep working.

- On the workstation, against the local images:
  `DESKMATES_SKIP_IMAGE_BUILD=1 DESKMATES_T2_PUBLIC_HOST=www.baidu.com WORKSPACE_IMAGE=$(docker image inspect deskmates/workspace:dev --format '{{.Id}}') npm run test:container -- --maxWorkers=2 >/tmp/t2-full.log 2>&1 &`
- On Testbox, against an installed release's own images:
  `T2_SCOPE=full nohup bash ~/Data/deskmates-stable/releases/vX.Y.Z/scripts/stable/stable.sh verify vX.Y.Z >/tmp/t2-full-vX.Y.Z.out 2>&1 &`.
  It starts its own short-lived containers and does not touch the running
  instance, but it rewrites that release's `t2.json`, `t2.log` and
  `t2.passed`; a failing run leaves the active release without `t2-passed` in
  `stable.sh status`, which is then accurate. Record the result in that
  release's file under [docs/releases/](../releases/README.md).

## Images

The workspace image is two layers (`images/workspace/README.md`): a ~3.4 GB
base (Playwright image, apt tools, SDK, MCP, CLI) that needs package
registries, and a ~0.5 MB app layer (contracts, sidecar, entry scripts) that
builds offline in seconds. Testbox cannot reach package registries or GHCR
reliably (every port-53 answer there is a Mihomo fake-IP, and GHCR resets on
the direct path), so:

- CI resolves the source-derived base tag in GHCR first. If it already exists,
  the workflow reuses that manifest and does not rebuild or overwrite the tag;
  otherwise it builds and pushes the base.
- `ship.sh` first checks whether the host has the manifest's exact base image
  ID. If not, it reuses an image already present under the same source-derived
  content tag; `stable.sh install` records both the actual image ID and the
  release workflow's ID in `.release/images.txt`. This covers older releases
  where CI or an authorized local fallback rebuilt identical inputs with
  different image metadata. Only when neither form is present does `ship.sh`
  pull the base on the workstation and stream it with
  `docker save | ssh testbox docker load`. This needs `docker login ghcr.io`
  on the workstation once, with a token that has `read:packages`
  (`gh auth refresh -s read:packages`, then
  `gh auth token | docker login ghcr.io -u <user> --password-stdin`).
- `stable.sh install` builds the app layer and the egress proxy on the host
  from the release source, under their content-addressed tags only (no `:dev`
  alias on the shared daemon). The egress proxy's base, `node:22-bookworm-slim`,
  is already present there.

Testbox stores no GitHub credential.

## Layout on Testbox

```
~/Data/deskmates-stable/
  releases/vX.Y.Z/            git archive of the tag + release-manifest.json
    .release/                 source.sha256, revision, images.env, npm/build/T2 logs,
                              t2.json receipt, installed / t2.passed / activated stamps
  current -> releases/vX.Y.Z  what the unit runs
  previous, last-backup       one-level rollback pointers
  shared/.env                 0600, humans only: model endpoint, secrets key, operator token
  shared/release.env          written by stable.sh: release, image IDs, Web and channel bundle paths
  shared/data/gateway.sqlite
  backups/<utc>-<from>-to-<to>/
~/.config/systemd/user/deskmates-stable-gateway.service
```

The Gateway serves the built UI on the operator listener
(`OPERATOR_BIND=0.0.0.0`, port 18381), so colleagues open
`http://10.20.40.132:18381/` and paste the operator token. The sandbox
listener is on 18380. There is one shared operator token: whoever has it has
full operator rights. Rotate it by editing `shared/.env` and restarting the
unit.

### Before deploying the first release with browser sign-in (ADR-0022 P1)

Releases built from the ADR-0022 P1 change replace token entry in the UI with
sign-in. This has not been deployed to Testbox; do these steps in the upgrade
window, after the usual database backup:

1. **Transport.** Production session cookies are `Secure` and browsers drop
   them over plain HTTP from a LAN address. Put a TLS reverse proxy in front of
   the operator listener and add its origin to `GATEWAY_ALLOWED_ORIGINS`, or
   accept the documented risk of `GATEWAY_SESSION_COOKIE=insecure-dev` (the
   session cookie then crosses the LAN in plain HTTP, as the token does today).
   Which one is the owner's decision.
2. **Migration.** Migration 0028 runs at startup: it creates the Default
   Tenant, assigns every workspace to it and keeps historical task acceptances
   as `human:web`. It creates no account.
3. **First Owner.** On Testbox, from the service's working directory, so the
   CLI reads `shared/.env` and resolves `GATEWAY_DB=./data/gateway.sqlite`
   exactly as the unit does:
   `cd ~/Data/deskmates-stable/shared && node ../current/packages/gateway/dist/auth/cli.js bootstrap-owner` (the root account, login `admin`)
   and type the password twice. The CLI prints the database file it opened
   (check it is `shared/data/gateway.sqlite`) and refuses a missing one. Create colleagues with `create-user --role
   admin|member`; hand passwords over out of band. Until then the UI shows
   "No account exists yet". Passwords are at least 12 characters unless
   `GATEWAY_PASSWORD_MIN_LENGTH` in `shared/.env` lowers the minimum (from
   v0.3.3; the CLI and the sign-in routes read the same value). Lower it only
   on a trial instance that deliberately uses fixed short passwords, and say
   so in that release's file under [docs/releases/](../releases/README.md).
4. **Machine clients** (WhatsApp adapters, scripts) keep using the operator
   token in the `Authorization` header; `?token=` on `/api/events` is no
   longer accepted, so upgrade adapters from the same release.
5. **Rollback.** Restore the pre-upgrade backup with the previous release; do
   not run an older binary on the migrated database.

## First-time setup

1. **GHCR read access on the workstation** (see Images), for the base transfer.
2. **Ship the first release** with `scripts/stable/ship.sh vX.Y.Z`, then on
   Testbox run `stable.sh init` from inside it. `init` creates
   `shared/.env` from `.env.example` with a fresh `GATEWAY_SECRETS_KEY` and
   operator token, ports 18380/18381, `OPERATOR_BIND=0.0.0.0` and
   `EGRESS_PROXY_DOH_URL=https://223.5.5.5/resolve` (ADR-0010 amendment 1),
   and installs the user unit.
3. **Model credentials** go into `shared/.env` over an ssh pipe, never through
   a file git tracks and never through a transcript:
   `grep -E '^(MODEL_BASE_URL|MODEL_AUTH_TOKEN|DEFAULT_MODEL|CHEAP_MODEL)=' .env | ssh testbox 'cat >> ~/Data/deskmates-stable/shared/.env'`
   (then remove any duplicate empty keys by hand).
4. `install`, `verify`, `activate`.
5. **Create the trial workspace** in the UI with the allowlist `*` (ADR-0010).
   It browses the open public internet, so it holds no production credentials.
   Anything that needs a sensitive login gets its own workspace with a narrow
   allowlist.

`GATEWAY_SECRETS_KEY` must never change: it encrypts stored refresh tokens.

## Taking over an installation that ran under a former product name

The first Deskmates release on a host that ran the product under an earlier name is not an
upgrade: the naming runbook (`deskmates-naming-upgrade.md`) says runtime names have no
compatibility aliases, so the new Gateway does not adopt the old containers, volumes, labels
or environment prefix. The database schema is the same lineage, so the data carries over.
`scripts/stable/import-legacy-instance.sh` does the hand-over; it takes the legacy root, unit
and lower-case prefix from `LEGACY_ROOT`, `LEGACY_UNIT` and `LEGACY_PREFIX`, and `DRY_RUN=1`
prints every change without touching anything.

1. **Ship and prepare, while the legacy instance keeps running.** `ship.sh vX.Y.Z` to the new
   root, then on the host `import-legacy-instance.sh prepare vX.Y.Z`: it copies the legacy
   `shared/.env` into the new root with `<FORMER>_*` keys renamed to `DESKMATES_*` and the
   release-owned keys dropped, keeping the secrets key, operator token and ports (so a TLS proxy
   in front of the operator port and every client keep working), then runs `stable.sh init`.
   The base image must be rebuilt (its inputs changed with the rename): `LOCAL_BASE=1
   stable.sh install vX.Y.Z`, then `stable.sh verify vX.Y.Z` with the full T2 for a minor tag.
   Neither step binds a port or touches the running instance.
2. **Cut over in a quiet window.** `import-legacy-instance.sh cutover vX.Y.Z` refuses while the
   legacy instance reports active runs, stops its unit, backs up its database under the legacy
   `backups/`, copies the database into the new root, deletes `bot_sessions` (saved SDK sessions
   name the old tool namespace and container targets and must not be resumed; threads, memory
   and files are untouched), copies each workspace's `profile`, `work` and `home` volumes under
   the new names with `cp -a` in a throwaway container, and runs `stable.sh activate`. The new
   Gateway recreates each workspace container under the new names on its first run.
3. **Verify, then retire.** Open the UI: workspaces, bots, thread history and old approval cards
   (their attachment type carries the former vendor segment; the contract accepts it). Trigger
   one run per workspace and check the browser login state and `/work` files survived. Then
   `import-legacy-instance.sh retire` removes the legacy workspace containers and networks and
   disables the legacy unit. Legacy volumes and root stay for rollback; remove them by hand later.
   Repoint anything that read the legacy database path (collectors, dashboards).

Rollback before `retire`: stop the new unit, start the legacy unit; nothing of the legacy
instance was changed. After `retire`: restore the legacy root's hand-over backup and start its
unit again; runs and messages written to the new instance since the cutover are lost.

## Upgrading

`scripts/stable/ship.sh vX.Y.Z --run`. Activation waits up to
`DRAIN_TIMEOUT` seconds (default 600) for executing runs to finish; parked
approval runs do not block it and resume on the new release. `FORCE=1`
stops anyway. The database is copied (with its WAL) while the Gateway is
stopped, then the new release starts and applies its migrations. On its
first use after the switch, the Gateway recreates each workspace container
whose image is not the release's, keeping the named volumes, so browser
profile, files and home directory survive.

## Rolling back

`stable.sh rollback` (asks for confirmation; `YES=1` skips it). It restores
the database backup taken when the current release was activated and switches
back to the previous release. **Everything written since the upgrade is
lost**: runs, messages, approvals, settings. Rollback is one level deep;
going further back means activating an older release as if it were new,
which migrations forbid when the schema moved forward. Prefer a fixed patch
release over a rollback when the data since the upgrade matters.

Activation rolls back by itself when the new release does not answer
`/healthz` and report its own version on `/api/config` within
`HEALTH_TIMEOUT` seconds (default 90).

## Integration runtime (ADR-0013)

Not yet deployed and not driven by `stable.sh`; this is the procedure the
next release that ships integrations follows. Until it runs, leave the three
`INTEGRATION_*` keys empty in `shared/.env`: the Gateway then offers no
integration to any run.

**Image.** OpenConnector, pinned by digest, never by tag:
`ghcr.io/oomol-lab/open-connector@sha256:55b1c424b454451d61e34ea6e2f540e625569d8f4c31cc4c5ec8052dadda4c9b`
(v1.7.0, the digest `acceptance/m3-integrations.container.test.ts` runs).
Testbox cannot reach GHCR; transfer it like the base image
(`docker save` on the workstation, `docker load` there) and record the digest
in the release manifest. An upgrade changes the digest only after the T2 above
and the per-provider smoke (ADR-0013 item 8) pass against the new image.

**Network.** One user-defined bridge network for the runtime alone, e.g.
`deskmates-stable-integrations` created with its own labels, never selected by
a name prefix. Only the Gateway reaches it: the Gateway runs on the host, so
publish the runtime's port 3000 on loopback only
(`-p 127.0.0.1:18382:3000`) and set
`INTEGRATION_RUNTIME_URL=http://127.0.0.1:18382`. Never attach a workspace
network to it; workspace networks are internal and reach only their egress
proxy, which the T2 checks (no TCP route by IP, container name or published
port). The runtime's admin console shares its port, so it is reachable only
from the host (use an SSH tunnel to look at it).

**State.** A named volume on `/app/data` (SQLite `connect.sqlite`, holding
the encrypted credentials and 5,000 run audit records with provider output:
treat it as sensitive). Back it up with the Gateway database before every
upgrade (stop the container, copy the volume); a rollback restores both
together, since the Gateway's connection table and the runtime's connections
must agree.

**Environment** (in a 0600 env file beside `shared/.env`, never in argv or a
tracked file):

```
OOMOL_CONNECT_ENCRYPTION_KEY=<openssl rand -base64 32; never changes, like GATEWAY_SECRETS_KEY>
OOMOL_CONNECT_ADMIN_TOKEN=<openssl rand -hex 24; also INTEGRATION_RUNTIME_ADMIN_TOKEN in shared/.env>
OOMOL_CONNECT_ORIGIN=http://127.0.0.1:18382
OOMOL_CONNECT_BLOCKED_PROXIES=*
HTTPS_PROXY / HTTP_PROXY           (optional: route provider calls through a managed egress proxy; untested)
```

Do not set `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` in production: the T2 needs
it only because its mock provider is on a private address. The admin token is
the bootstrap credential; the spike found `/mcp` and `/v1` answer without
authentication until the first runtime token exists, and the Gateway creates
per-workspace tokens only when the first connection is added. So start the
container, then, before any other client can reach it (it is on loopback
only), mint one runtime token with an empty-grant policy that nothing uses:

```
curl -fsS -X POST http://127.0.0.1:18382/api/runtime-tokens \
  -H "authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"bootstrap-lock","allowedActions":["none.none"],"blockedActions":[],"allowedProxies":[],"allowedConnections":["00000000-0000-0000-0000-000000000000"]}'
```

The stable runtime carries this `bootstrap-lock` token (verified 2026-10-09).
Once any runtime token exists, v1.7.0 also stops answering `GET /v1/providers`
to the admin token; the Gateway therefore mints its own inert `deskmates-catalog`
token on the first catalog read and lists apps with it (ADR-0013 amendment 3),
which closes the unauthenticated window on a deployment that skipped this step.
If the runtime rejects the unknown connection id, create the lock token after
the first real connection exists instead, and keep the runtime unreachable
until then.

**Callback URL.** OAuth grants need `INTEGRATION_OAUTH_CALLBACK_URL`, the
HTTPS URL at which the operator's browser reaches
`/api/integrations/oauth/callback` on the operator listener (behind the TLS
reverse proxy; Google accepts plain HTTP only for localhost). The same URL is
registered as the redirect URI of each provider's OAuth app and is sent to
the runtime by `PUT /api/integrations/providers/:service/oauth-app`. The
runtime itself needs no inbound internet access, only outbound HTTPS to the
providers for code exchange and actions. API-key connections work without a
callback URL.

**Unit.** A second user unit, `deskmates-stable-integrations.service`, runs the
container (`docker run --rm --name deskmates-stable-integration-runtime ...`)
and starts before `deskmates-stable-gateway.service`. The Gateway starts without
it; every integration call then answers `503 integration_unavailable` until
the runtime is back.

**After installing**, as the operator: adopt only the providers that have a
smoke (`POST /api/integrations/providers`), then create connections per
workspace from the Integrations screen. A trial workspace with the `*`
allowlist holds no production credentials, and neither do its integration
connections (default grouping rule).

## Known limits

- **Recreation happens on first use.** A workspace switches to the new image
  the first time a run needs it after the upgrade, not at startup. Until then
  its takeover screen shows the old container, and a human watching it at
  that moment loses the screen when the run recreates it. The human browser
  lock is not released by that recreation; hand back and take over again.
- **A proxy-only image change restarts every workspace** (Chromium included)
  on first use, because the workspace container pins the proxy's address.
- **Changing `EGRESS_PROXY_DOH_URL` or `EGRESS_PROXY_DNS` does not reach
  existing proxies.** Only a proxy created after the change uses it; restart
  the workspace to apply it.
- **Open internet means what Testbox's direct path reaches.** The proxy
  resolves over DoH and connects to the real address; sites reset on the
  direct path from China (e.g. Google, GHCR) stay unreachable.
- **Under `*`, `localhost`, `*.localhost` and `host.docker.internal` stay
  denied** at the tool level, so an open-internet bot cannot reach Chromium's
  debugging port or host services (ADR-0010 decision 2).
- **Takeover from another machine goes through bot desktops.** The chat
  header's workspace-level noVNC link points at the Gateway host's loopback;
  opened from the LAN, the UI takes the lock and directs the user to the bot
  desktop view, which streams through the Gateway.
- **Plain HTTP.** The operator token crosses the LAN unencrypted unless a TLS
  reverse proxy sits in front.
- **Drain is best effort.** A queued run can start between the last
  `/api/runtime` poll and the stop; the next start fails it in `reconcile`.

## Keeping it separate from test work

The same Docker daemon runs test campaigns and other agents' instances.

- Its containers, networks and volumes are found by the workspace ids in its
  own database (`deskmates.workspace` label), never by a `deskmates-` name prefix.
  `scripts/deploy-local.sh purge` in another checkout touches only that
  checkout's workspaces.
- Never prune images or the build cache on Testbox.
- T2 during `verify` starts its own short-lived containers; it does not touch
  the running instance.

## Operations

- `stable.sh status`: current and previous release, unit state, reported
  release, active runs, and each installed release's stamps.
- Logs: `journalctl --user -u deskmates-stable-gateway -f`.
- Restart after editing `shared/.env`:
  `systemctl --user restart deskmates-stable-gateway`.

## Verification records

What each release verified (gates and numbers, receipts, backups, exceptions, what was not yet
done live) is recorded in [docs/releases/](../releases/README.md), one file per release named
`YYYY-MM-DD-<tag>.md`. Add a new file for each release; do not append to a shared log here.

## Cleaning up after test runs on Testbox

A Gateway never removes workspaces on shutdown; workspaces are meant to
persist. Anything that starts a throwaway Gateway there (evaluation runners,
demo instances) must remove its workspaces when it ends, by the ids in its
own database, as `scripts/deploy-local.sh purge` does. Otherwise each leaked
workspace keeps one Docker network, and the daemon's default address pools
(about 30 networks) run out.
