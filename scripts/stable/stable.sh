#!/usr/bin/env bash
# Operate the long-lived Deskmates deployment on this host (AGENTS.md, "Stable release deployment";
# docs/runbooks/stable-release.md). Run it from inside a release: releases/<v>/scripts/stable/.
#
#   stable.sh init                first-time setup: directories, shared .env, systemd user unit
#   stable.sh install  vX.Y.Z     npm ci + build in releases/vX.Y.Z; build its app and egress
#                                 images offline on the base the manifest pins
#   stable.sh verify   vX.Y.Z     T2 against exactly those images; receipt in releases/vX.Y.Z/.release;
#                                 smoke subset for a patch tag, full suite for vX.Y.0
#                                 (T2_SCOPE=full|smoke overrides)
#   stable.sh activate vX.Y.Z     drain, stop, back up the DB, switch, start, health-check;
#                                 rolls back by itself when the new release does not come up.
#                                 The drain (ADR-0029) stops the Gateway starting runs and parks
#                                 each active run at its next tool call; a run that does not get
#                                 there within DRAIN_BUDGET ends the drain, and the upgrade is
#                                 retried after UPGRADE_RETRY_BACKOFF, UPGRADE_ATTEMPTS times in all.
#                                 FORCE=1 stops anyway; the next Gateway parks and resumes the runs
#   stable.sh rollback            previous release plus the DB backup taken when leaving it
#   stable.sh status
#   stable.sh grafana init        Grafana state directory and image for the current release
#                                 (ADR-0046 decision 6 and amendment 1; docs/runbooks/grafana.md)
#   stable.sh grafana start       run it on the host loopback behind the Gateway's /analytics/
#                                 relay, with the current release's provisioning; a no-op when it
#                                 already runs exactly that, else recreated
#   stable.sh grafana stop|status
#   stable.sh searxng init        SearXNG secret, cache directory and image for the current release
#                                 (ADR-0049 decision 14; packages/gateway/docs/web-search.md)
#   stable.sh searxng start       run it on the host loopback for the Gateway's web search proxy;
#                                 a no-op when it already runs exactly that, else recreated
#   stable.sh searxng stop|status
#
# Layout under DESKMATES_STABLE_ROOT (default ~/Data/deskmates-stable):
#   releases/<v>/              extracted source of one tag + release-manifest.json + .release/
#   current -> releases/<v>    what the unit runs
#   shared/.env                0600, owned by humans: model endpoint, secrets key, operator token
#   shared/release.env         written here on every switch: release, image IDs, UI directory
#   shared/data/               the Gateway database (and obs.sqlite with OBSERVABILITY_SINK=sqlite)
#   grafana/                   0700: Grafana's own state (data/); no password (ADR-0046 amendment 1)
#   searxng/                   0700: env (0600, SEARXNG_SECRET) and cache/ (ADR-0049 decision 14)
#   backups/<ts>-<from>-to-<to>/
#
# The Gateway reads shared/.env itself (process.loadEnvFile), and systemd's EnvironmentFile
# values win over it, so release.env always decides which images and UI a release runs.
set -euo pipefail

ROOT="${DESKMATES_STABLE_ROOT:-$HOME/Data/deskmates-stable}"
SHARED="$ROOT/shared"
RELEASES="$ROOT/releases"
BACKUPS="$ROOT/backups"
UNIT="deskmates-stable-gateway.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
HERE="$(cd "$(dirname "$0")" && pwd)"
# ADR-0029 decision 3; all four are guesses to calibrate on the drain-time metric. DRAIN_TIMEOUT is
# the name before the drain route existed, still honoured.
DRAIN_BUDGET="${DRAIN_BUDGET:-${DRAIN_TIMEOUT:-120}}"
DRAIN_POLL="${DRAIN_POLL:-5}"
UPGRADE_RETRY_BACKOFF="${UPGRADE_RETRY_BACKOFF:-600}"
UPGRADE_ATTEMPTS="${UPGRADE_ATTEMPTS:-3}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

say()  { printf '==> %s\n' "$*"; }
ok()   { printf ' ok  %s\n' "$*"; }
warn() { printf 'warn %s\n' "$*" >&2; }
die()  { printf 'error %s\n' "$*" >&2; exit 1; }

check_version() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a version like v0.2.0, got '${1:-}'"
}

# One key from shared/.env without exporting the file.
env_get() {
  grep -E "^$1=" "$SHARED/.env" 2>/dev/null | head -1 | cut -d= -f2- |
    sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

env_set() { # key value; replaces the line or appends it
  local key="$1" value="$2"
  if grep -qE "^$key=" "$SHARED/.env"; then
    KEY="$key" VALUE="$value" perl -pi -e 's/^\Q$ENV{KEY}\E=.*/$ENV{KEY}=$ENV{VALUE}/' "$SHARED/.env"
  else
    printf '%s=%s\n' "$key" "$value" >>"$SHARED/.env"
  fi
}

manifest_get() { # release-dir js-expression-over-m
  node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);if(v===undefined||v===null)process.exit(3);process.stdout.write(String(v))' \
    "$1/release-manifest.json" "$2"
}

retry() { # attempts command...
  local n="$1" i; shift
  for i in $(seq 1 "$n"); do
    "$@" && return 0
    [ "$i" -lt "$n" ] && { warn "attempt $i/$n failed: $*"; sleep $((i * 5)); }
  done
  return 1
}

current_version() { [ -L "$ROOT/current" ] && basename "$(readlink "$ROOT/current")" || true; }

ports() {
  GATEWAY_PORT="$(env_get GATEWAY_PORT)"; GATEWAY_PORT="${GATEWAY_PORT:-8080}"
  OPERATOR_PORT="$(env_get OPERATOR_PORT)"; OPERATOR_PORT="${OPERATOR_PORT:-8081}"
  OPERATOR_TOKEN="$(env_get GATEWAY_OPERATOR_TOKEN)"
}

api() { # path
  curl -fsS --max-time 5 -H "authorization: Bearer $OPERATOR_TOKEN" "http://127.0.0.1:$OPERATOR_PORT$1"
}

api_call() { # method path; for the routes that change something
  curl -fsS --max-time 5 -X "$1" -H "authorization: Bearer $OPERATOR_TOKEN" \
    "http://127.0.0.1:$OPERATOR_PORT$2"
}

db_path() {
  local db; db="$(env_get GATEWAY_DB)"; db="${db:-./data/gateway.sqlite}"
  case "$db" in /*) echo "$db" ;; *) echo "$SHARED/${db#./}" ;; esac
}

# --- init ----------------------------------------------------------------------------------------

cmd_init() {
  local release_root; release_root="$(cd "$HERE/../.." && pwd)"
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable"
  local node; node="$(command -v node)" || die "node is not installed"
  [ "$("$node" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node 22+ required"
  mkdir -p "$SHARED/data" "$RELEASES" "$BACKUPS" "$(dirname "$UNIT_FILE")"
  chmod 700 "$ROOT" "$SHARED"

  if [ ! -f "$SHARED/.env" ]; then
    say "creating $SHARED/.env from .env.example"
    (umask 077; cp "$release_root/.env.example" "$SHARED/.env")
    env_set GATEWAY_SECRETS_KEY "$(openssl rand -base64 32)"
    env_set GATEWAY_OPERATOR_TOKEN "$(openssl rand -base64 32 | tr '+/' '-_')"
    env_set GATEWAY_PORT 18380
    env_set OPERATOR_PORT 18381
    env_set OPERATOR_BIND 0.0.0.0
    env_set GATEWAY_DB ./data/gateway.sqlite
    # Every port-53 query on Testbox is answered with a Mihomo fake-IP the proxy must refuse;
    # DNS-over-HTTPS to an IP literal is not intercepted (ADR-0010 amendment 1).
    env_set EGRESS_PROXY_DOH_URL https://223.5.5.5/resolve
    # The public site T2's reachability cases fetch; the host's international path is not
    # dependable (a desktop proxy owns it), a domestic site is.
    env_set T2_PUBLIC_HOST www.baidu.com
    # release.env owns these; a value here would be overridden and only confuse a reader.
    perl -ni -e 'print unless /^(WORKSPACE_IMAGE|EGRESS_PROXY_IMAGE|WEB_DIST_DIR|CHANNEL_PLUGIN_MANIFEST|DESKMATES_RELEASE)=/' "$SHARED/.env"
    ok "generated GATEWAY_SECRETS_KEY and GATEWAY_OPERATOR_TOKEN; never change the secrets key"
  fi
  chmod 600 "$SHARED/.env"

  say "writing $UNIT_FILE"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Deskmates stable Gateway ($ROOT)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$SHARED
EnvironmentFile=$SHARED/release.env
ExecStart=$node $ROOT/current/packages/gateway/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  ok "unit installed and enabled (it starts on the first activate)"
  [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ] ||
    warn "linger is off: the Gateway stops when you log out (sudo loginctl enable-linger $USER)"

  local missing=() k
  for k in MODEL_BASE_URL MODEL_AUTH_TOKEN DEFAULT_MODEL CHEAP_MODEL; do
    [ -n "$(env_get "$k")" ] || missing+=("$k")
  done
  [ "${#missing[@]}" -eq 0 ] || warn "fill in $SHARED/.env before activate: ${missing[*]}"
}

# --- install -------------------------------------------------------------------------------------

cmd_install() {
  local v="$1"; check_version "$v"
  local rel="$RELEASES/$v" meta="$RELEASES/$v/.release"
  [ -f "$rel/release-manifest.json" ] || die "$rel/release-manifest.json missing; ship the release first"
  [ "$(manifest_get "$rel" m.version)" = "$v" ] || die "manifest version does not match $v"
  mkdir -p "$meta"

  say "npm ci in $rel"
  (cd "$rel" && retry 3 npm ci --no-audit --no-fund) >"$meta/npm-ci.log" 2>&1 ||
    { tail -20 "$meta/npm-ci.log" >&2; die "npm ci failed; see $meta/npm-ci.log"; }
  say "building gateway, release-bundled channels and web UI"
  (cd "$rel" && npm run typecheck && npm run build -w packages/channels && \
    npm run build -w packages/web) >"$meta/build.log" 2>&1 ||
    { tail -20 "$meta/build.log" >&2; die "build failed; see $meta/build.log"; }
  [ -f "$rel/packages/channels/dist/channel-plugins.json" ] ||
    die "channel plugin build produced no channel-plugins.json"

  # The base (browser, SDK, tools) is the only image that needs package registries; it comes from
  # the release workflow and ship.sh loads it here when missing. Prefer the manifest's exact
  # image ID, but reuse an existing image under the source-derived content tag: two CI builds of
  # identical inputs may differ only in config metadata and therefore have different image IDs.
  local base_tag base_id local_base_id
  base_tag="$(manifest_get "$rel" m.base.contentTag)" || die "manifest names no base image"
  base_id="$(manifest_get "$rel" m.base.imageId)" || die "manifest names no base image ID"
  [ "$(cd "$rel" && node scripts/image-tag.mjs base --arch amd64)" = "$base_tag" ] ||
    die "the release source does not hash to the manifest's base $base_tag"
  local base_note="from the release workflow"
  if docker image inspect "$base_id" >/dev/null 2>&1; then
    docker tag "$base_id" "$base_tag"
  elif local_base_id="$(docker image inspect --format '{{.Id}}' "$base_tag" 2>/dev/null)" &&
    [[ "$local_base_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    base_note="reused existing content-addressed base; the release workflow's base is $base_id"
    base_id="$local_base_id"
  elif [ "${LOCAL_BASE:-}" = "1" ]; then
    # Owner-approved fallback (2026-09-28): when the workstation cannot pull the base from GHCR,
    # build the same Dockerfile here. Its apt and npm layers come from this host's build cache
    # or network, so the ID differs from the release workflow's; images.txt records both.
    say "LOCAL_BASE=1: building $base_tag on this host"
    # APT_MIRROR (optional, .env) points apt at a faster Ubuntu mirror for this build only, and the
    # npm_config_registry install runs with (ship.sh passes it) does the same for npm.
    (cd "$rel" && docker build --build-arg APT_MIRROR="$(env_get APT_MIRROR)" \
      --build-arg NPM_REGISTRY="${npm_config_registry:-}" \
      -f images/workspace-base/Dockerfile -t "$base_tag" images/workspace-base) \
      >"$meta/base.log" 2>&1 || { tail -20 "$meta/base.log" >&2; die "local base build failed; see $meta/base.log"; }
    base_note="built on this host (LOCAL_BASE=1); the release workflow's base is $base_id"
    base_id="$(docker image inspect --format '{{.Id}}' "$base_tag")"
  else
    die "base $base_tag ($base_id) is not on this host; ship.sh transfers it (or LOCAL_BASE=1)"
  fi
  ok "base: $base_tag ($base_id), $base_note"

  # The app layer and the egress proxy build offline from the release source, under their
  # content-addressed tags only (no :dev alias on a shared daemon).
  local ws_tag eg_tag ws_id eg_id
  ws_tag="$(cd "$rel" && node scripts/image-tag.mjs workspace --arch amd64)"
  eg_tag="$(cd "$rel" && node scripts/image-tag.mjs egress --arch amd64)"
  say "building $ws_tag and $eg_tag"
  (cd "$rel" && SKIP_SIDECAR_BUILD=1 BASE_IMAGE="$base_tag" WORKSPACE_IMAGE="$ws_tag" \
    bash scripts/build-workspace-image.sh && EGRESS_PROXY_IMAGE="$eg_tag" \
    bash scripts/build-egress-image.sh) >"$meta/images.log" 2>&1 ||
    { tail -20 "$meta/images.log" >&2; die "image build failed; see $meta/images.log"; }
  ws_id="$(docker image inspect --format '{{.Id}}' "$ws_tag")"
  eg_id="$(docker image inspect --format '{{.Id}}' "$eg_tag")"
  printf 'WORKSPACE_IMAGE=%s\nEGRESS_PROXY_IMAGE=%s\n' "$ws_id" "$eg_id" >"$meta/images.env"
  printf 'base %s %s %s\nworkspace %s %s\negress %s %s\n' "$base_tag" "$base_id" "$base_note" \
    "$ws_tag" "$ws_id" "$eg_tag" "$eg_id" >"$meta/images.txt"
  ok "workspace: $ws_tag ($ws_id)"
  ok "egress: $eg_tag ($eg_id)"
  date -u +%FT%TZ >"$meta/installed"
  ok "installed $v; next: stable.sh verify $v"
}

# --- verify (T2) ---------------------------------------------------------------------------------

# Which T2 files gate this release (docs/runbooks/stable-release.md, "Which gate for which
# release"): a patch tag (vX.Y.Z, Z > 0) runs the smoke subset in acceptance/t2-smoke.list, a
# minor tag (vX.Y.0) the full suite. T2_SCOPE=full|smoke overrides either way.
t2_scope() { # version
  local scope="${T2_SCOPE:-}"
  if [ -z "$scope" ]; then
    if [ "${1##*.}" -eq 0 ]; then scope=full; else scope=smoke; fi
  fi
  [ "$scope" = full ] || [ "$scope" = smoke ] || die "T2_SCOPE must be full or smoke, got '$scope'"
  printf '%s' "$scope"
}

t2_files() { # release-dir scope; one repo-relative path per line, the files that scope runs
  if [ "$2" = smoke ]; then
    grep -Ev '^[[:space:]]*(#|$)' "$1/acceptance/t2-smoke.list"
  else
    (cd "$1" && find acceptance packages -name '*.container.test.ts' \
      -not -path '*/node_modules/*' -not -path '*/dist/*' | LC_ALL=C sort)
  fi
}

cmd_verify() {
  local v="$1"; check_version "$v"
  local rel="$RELEASES/$v" meta="$RELEASES/$v/.release"
  [ -f "$meta/installed" ] || die "$v is not installed"
  local W E; W="$(grep '^WORKSPACE_IMAGE=' "$meta/images.env" | cut -d= -f2)"
  E="$(grep '^EGRESS_PROXY_IMAGE=' "$meta/images.env" | cut -d= -f2)"
  [ ! -e "$rel/.env" ] || die "$rel/.env exists; T2 must run without model credentials"
  local scope script files
  scope="$(t2_scope "$v")"
  if [ "$scope" = smoke ]; then
    [ -f "$rel/acceptance/t2-smoke.list" ] || die "$v has no acceptance/t2-smoke.list; use T2_SCOPE=full"
    script=test:container:smoke
  else
    script=test:container
  fi
  files="$(t2_files "$rel" "$scope" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean))))')"
  rm -f "$meta/t2.passed" "$meta/t01.passed"
  # T0/T1 runs here, not online: the release workflow only packages (owner decision 2026-10-13).
  # The shell running verify may carry release settings (LOCAL_BASE, the npm registry) that the
  # release scripts' own tests read, so T0/T1 runs without them, like a clean CI machine.
  say "T0/T1 for $v"
  local status
  set +e
  (cd "$rel" && env -u MODEL_BASE_URL -u MODEL_AUTH_TOKEN -u DEFAULT_MODEL -u CHEAP_MODEL -u LOCAL_BASE -u npm_config_registry -u T2_SCOPE \
    npm test -- --maxWorkers="${T01_MAX_WORKERS:-12}") >"$meta/t01.log" 2>&1
  status=$?
  set -e
  grep -E "Test Files|Tests " "$meta/t01.log" | tail -2 || true
  [ "$status" -eq 0 ] || die "T0/T1 failed for $v; see $meta/t01.log"
  touch "$meta/t01.passed"
  say "T2 ($scope) for $v against $W"
  local started status; started="$(date -u +%FT%TZ)"
  set +e
  # T2's egress proxies resolve the way the deployment's do: on this host a port-53 answer is a
  # fake IP, so the public-reachability cases need the same DoH resolver (ADR-0010).
  (cd "$rel" && env -u MODEL_BASE_URL -u MODEL_AUTH_TOKEN -u DEFAULT_MODEL -u CHEAP_MODEL \
    EGRESS_PROXY_DOH_URL="$(env_get EGRESS_PROXY_DOH_URL)" EGRESS_PROXY_DNS="$(env_get EGRESS_PROXY_DNS)" \
    DESKMATES_T2_PUBLIC_HOST="$(env_get T2_PUBLIC_HOST)" \
    DESKMATES_SKIP_IMAGE_BUILD=1 WORKSPACE_IMAGE="$W" EGRESS_PROXY_IMAGE="$E" \
    npm run "$script" -- --maxWorkers="${T2_MAX_WORKERS:-6}") >"$meta/t2.log" 2>&1
  status=$?
  set -e
  printf '{"version":"%s","startedAt":"%s","finishedAt":"%s","exitCode":%d,"workspaceImage":"%s","egressImage":"%s","scope":"%s","files":%s}\n' \
    "$v" "$started" "$(date -u +%FT%TZ)" "$status" "$W" "$E" "$scope" "$files" >"$meta/t2.json"
  grep -E "Test Files|Tests " "$meta/t2.log" | tail -2 || true
  [ "$status" -eq 0 ] || die "T2 failed for $v; see $meta/t2.log"
  touch "$meta/t2.passed"
  ok "T2 passed; receipt $meta/t2.json"
}

# --- activate / rollback -------------------------------------------------------------------------

# Poll /api/runtime until no run is active or DRAIN_BUDGET passes. Sets ACTIVE (count) and
# ACTIVE_IDS; returns 0 at zero, 1 past the budget, 2 when the Gateway has no /api/runtime.
wait_for_safe_point() {
  local waited=0 body
  while :; do
    body="$(api /api/runtime 2>/dev/null)" || return 2
    ACTIVE="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).activeRuns))' "$body")"
    ACTIVE_IDS="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).activeRunIds||[]).join(" "))' "$body")"
    [ "$ACTIVE" = "0" ] && return 0
    [ "$waited" -ge "$DRAIN_BUDGET" ] && return 1
    say "waiting for $ACTIVE active run(s) to reach a safe point ($waited/${DRAIN_BUDGET}s)"
    sleep "$DRAIN_POLL"; waited=$((waited + DRAIN_POLL))
  done
}

# ADR-0029 decisions 1 and 3. The drain route stops the Gateway starting or resuming runs while it
# keeps accepting messages, approvals, webhooks and cron ticks; each active run parks at its next
# tool call and the next Gateway continues it. A run with no safe point inside the budget (a long
# tool call or model turn) ends the drain unforced, so launching resumes, and the upgrade is tried
# again after the backoff. A Gateway from before the route is drained the old way: wait for it.
drain() {
  systemctl --user is-active --quiet "$UNIT" || return 0
  ports
  local attempt=1 status
  while :; do
    if ! api_call POST /api/runtime/drain >/dev/null 2>&1; then
      warn "the running Gateway has no drain route; waiting for its active runs to finish instead"
      status=0; wait_for_safe_point || status=$?
      [ "$status" -eq 2 ] && { warn "the running Gateway has no /api/runtime; stopping without draining"; return 0; }
      [ "$status" -eq 0 ] && { ok "no active runs"; return 0; }
      [ "${FORCE:-}" = "1" ] || die "$ACTIVE run(s) still active after ${DRAIN_BUDGET}s; retry later or FORCE=1"
      warn "FORCE=1: stopping with $ACTIVE active run(s)"
      return 0
    fi
    say "drain $attempt/$UPGRADE_ATTEMPTS: no run starts or resumes; active runs park at their next tool call"
    status=0; wait_for_safe_point || status=$?
    [ "$status" -eq 0 ] && { ok "every active run reached a safe point"; return 0; }
    [ "$status" -eq 2 ] && { warn "/api/runtime stopped answering; stopping"; return 0; }
    if [ "${FORCE:-}" = "1" ]; then
      warn "FORCE=1: stopping with $ACTIVE active run(s) ($ACTIVE_IDS); the next Gateway parks and resumes them"
      return 0
    fi
    api_call DELETE /api/runtime/drain >/dev/null 2>&1 || warn "the drain could not be ended"
    [ "$attempt" -ge "$UPGRADE_ATTEMPTS" ] &&
      die "$ACTIVE run(s) never reached a safe point in $UPGRADE_ATTEMPTS drain(s) of ${DRAIN_BUDGET}s: $ACTIVE_IDS; the Gateway runs on; retry later or FORCE=1"
    warn "$ACTIVE run(s) still active after ${DRAIN_BUDGET}s ($ACTIVE_IDS); drain ended, retrying in ${UPGRADE_RETRY_BACKOFF}s"
    sleep "$UPGRADE_RETRY_BACKOFF"
    attempt=$((attempt + 1))
  done
}

write_release_env() { # version
  local rel="$RELEASES/$1" channel_manifest
  channel_manifest="$RELEASES/$1/packages/channels/dist/channel-plugins.json"
  {
    echo "DESKMATES_RELEASE=$1"
    cat "$rel/.release/images.env"
    echo "WEB_DIST_DIR=$rel/packages/web/dist"
    # Releases from before the in-process channel ABI have no bundle. Omitting the key keeps a
    # one-level rollback to such a release valid; every newly installed release is checked above.
    [ ! -f "$channel_manifest" ] || echo "CHANNEL_PLUGIN_MANIFEST=$channel_manifest"
  } >"$SHARED/release.env.tmp"
  chmod 600 "$SHARED/release.env.tmp"
  mv -f "$SHARED/release.env.tmp" "$SHARED/release.env"
}

switch_to() { # version; the unit is stopped, so replacing the link need not be atomic
  ln -sfn "releases/$1" "$ROOT/current"
}

backup_db() { # dir
  local db; db="$(db_path)"
  mkdir -p "$1"
  local f
  for f in "$db" "$db-wal" "$db-shm"; do [ -f "$f" ] && cp -p "$f" "$1/"; done
  return 0
}

restore_db() { # dir
  local db; db="$(db_path)"
  rm -f "$db" "$db-wal" "$db-shm"
  local f
  for f in "$1"/*; do [ -f "$f" ] && [[ "$(basename "$f")" == "$(basename "$db")"* ]] && cp -p "$f" "$(dirname "$db")/"; done
  return 0
}

healthy() { # version
  ports
  local i body
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$GATEWAY_PORT/healthz" >/dev/null 2>&1 &&
      body="$(api /api/config 2>/dev/null)"; then
      [ "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).release))' "$body")" = "$1" ] && return 0
    fi
    sleep 1
  done
  return 1
}

cmd_activate() {
  local v="$1"; check_version "$v"
  local meta="$RELEASES/$v/.release"
  [ -f "$meta/installed" ] || die "$v is not installed"
  if [ ! -f "$meta/t2.passed" ]; then
    [ "${SKIP_T2:-}" = "1" ] || die "T2 has not passed for $v; run verify (SKIP_T2=1 records an exception)"
    date -u +%FT%TZ >"$meta/t2.skipped"
    warn "activating $v without T2 (recorded in $meta/t2.skipped)"
  fi
  [ -f "$SHARED/.env" ] || die "no $SHARED/.env; run init first"
  local k
  for k in MODEL_BASE_URL MODEL_AUTH_TOKEN DEFAULT_MODEL CHEAP_MODEL GATEWAY_SECRETS_KEY GATEWAY_OPERATOR_TOKEN; do
    [ -n "$(env_get "$k")" ] || die "$k is empty in $SHARED/.env"
  done
  local prev; prev="$(current_version)"
  [ "$prev" != "$v" ] || die "$v is already current"

  drain
  say "stopping the Gateway"
  systemctl --user stop "$UNIT" || true
  local backup; backup="$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-${prev:-none}-to-$v"
  backup_db "$backup"
  echo "${prev}" >"$ROOT/previous"
  echo "$backup" >"$ROOT/last-backup"
  ok "database backed up to $backup"

  write_release_env "$v"
  switch_to "$v"
  say "starting $v"
  systemctl --user start "$UNIT"
  if healthy "$v"; then
    date -u +%FT%TZ >"$meta/activated"
    ok "$v is live (UI http://<this host>:$OPERATOR_PORT/)"
    return 0
  fi
  warn "$v did not become healthy; journal:"
  journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
  if [ -n "$prev" ]; then
    rollback_to "$prev" "$backup"
    die "activation of $v failed; rolled back to $prev"
  fi
  systemctl --user stop "$UNIT" || true
  die "activation of $v failed and there is no previous release"
}

rollback_to() { # version backup-dir
  say "rolling back to $1"
  systemctl --user stop "$UNIT" || true
  restore_db "$2"
  write_release_env "$1"
  switch_to "$1"
  : >"$ROOT/previous"
  systemctl --user start "$UNIT"
  healthy "$1" || die "rollback target $1 is not healthy either; see journalctl --user -u $UNIT"
  ok "running $1 with the database as it was before the upgrade"
}

cmd_rollback() {
  local prev backup
  prev="$(cat "$ROOT/previous" 2>/dev/null || true)"
  backup="$(cat "$ROOT/last-backup" 2>/dev/null || true)"
  [ -n "$prev" ] || die "no previous release recorded"
  [ -d "$backup" ] || die "backup $backup is missing"
  warn "everything written since the upgrade (runs, messages, settings) is lost"
  [ "${YES:-}" = "1" ] || { read -r -p "roll back to $prev? [y/N] " a; [ "$a" = "y" ] || exit 1; }
  drain
  rollback_to "$prev" "$backup"
}

cmd_status() {
  echo "root     $ROOT"
  echo "current  $(current_version || true)"
  echo "previous $(cat "$ROOT/previous" 2>/dev/null || true)"
  systemctl --user --no-pager --lines=0 status "$UNIT" 2>/dev/null | sed -n '1,3p' || true
  if [ -f "$SHARED/.env" ]; then
    ports
    api /api/config 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("release  "+JSON.parse(s).release))' || echo "api      unreachable"
    api /api/runtime 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("active   "+JSON.parse(s).activeRuns))' || true
  fi
  local d
  for d in "$RELEASES"/*/; do
    [ -d "$d" ] || continue
    local m="$d.release" s=""
    [ -f "$m/installed" ] && s+=" installed"
    [ -f "$m/t2.passed" ] && s+=" t2-passed"
    [ -f "$m/t2.skipped" ] && s+=" t2-skipped"
    [ -f "$m/activated" ] && s+=" activated"
    echo "release  $(basename "$d"):$s"
    node "$HERE/t2-status.mjs" "$d"
  done
}

# --- grafana (ADR-0046 decision 6 and amendment 1) -----------------------------------------------

# One container on the host network, beside the Gateway rather than under its unit: the Gateway's
# upgrades and rollbacks never touch it, and it reads the obs file the Gateway writes, read-only.
# Provisioning (datasource and dashboards for the selected engine) is mounted from the current
# release's observability/grafana/<engine>/, generated by packages/observability-dashboards.
#
# Amendment 1: it listens on 127.0.0.1 only, under /analytics/, and signs in whoever the
# X-WEBAUTH-USER header names from loopback (auth.proxy). The Gateway's /analytics relay is that
# client, for the root's own session, and only ever names admin, a Viewer. No Grafana administrator
# or password exists; /analytics/api/health needs no sign-in, which is all start and status read.
GRAFANA_STATE="$ROOT/grafana"
GRAFANA_CONTAINER="${GRAFANA_CONTAINER:-deskmates-stable-grafana}"
GRAFANA_HEALTH_TIMEOUT="${GRAFANA_HEALTH_TIMEOUT:-60}"

env_opt() { env_get "$1" || true; } # a key an older shared/.env may not have

grafana_release() { # prints the current release directory
  local v; v="$(current_version)"
  [ -n "$v" ] || die "no current release; activate one before Grafana"
  printf '%s' "$RELEASES/$v"
}

grafana_tag() { # release-dir
  (cd "$1" && node scripts/image-tag.mjs grafana --arch "${IMAGE_ARCH:-amd64}")
}

# Reads the settings from shared/.env into GF_* shell variables.
grafana_settings() {
  [ -f "$SHARED/.env" ] || die "no $SHARED/.env; run init first"
  GF_PORT="$(env_opt OBSERVABILITY_GRAFANA_PORT)"; GF_PORT="${GF_PORT:-18700}"
  [[ "$GF_PORT" =~ ^[0-9]+$ ]] && [ "$GF_PORT" -ge 1 ] && [ "$GF_PORT" -le 65535 ] ||
    die "OBSERVABILITY_GRAFANA_PORT must be a port number, got '$GF_PORT'"
  # Retired by amendment 1 decision 12: refused rather than silently ignored.
  case "$(env_opt OBSERVABILITY_GRAFANA_ANONYMOUS)" in
    "" | 0) ;;
    *) die "OBSERVABILITY_GRAFANA_ANONYMOUS is retired (ADR-0046 amendment 1): Grafana is the root's alone, through the Gateway's /analytics/; remove it from $SHARED/.env" ;;
  esac
  GF_URL="$(env_opt OBSERVABILITY_GRAFANA_URL)"
  # What the Gateway relays /analytics/ to: Grafana's own loopback origin.
  GF_UPSTREAM="http://127.0.0.1:$GF_PORT"
  GF_ENGINE="$(env_opt OBSERVABILITY_SINK)"
  # Phase 1 bundles the sqlite sink only; the Gateway refuses any other id at startup too.
  [ "$GF_ENGINE" = sqlite ] ||
    die "Grafana reads the obs model; set OBSERVABILITY_SINK=sqlite in $SHARED/.env (got '${GF_ENGINE}')"
  # The Gateway runs in $SHARED, so a relative path is relative to it; the default is obs.sqlite
  # beside the ledger (packages/gateway/docs/run-observability.md).
  local obs; obs="$(env_opt OBSERVABILITY_SQLITE_PATH)"
  if [ -z "$obs" ]; then obs="$(dirname "$(db_path)")/obs.sqlite"
  else case "$obs" in /*) ;; *) obs="$SHARED/${obs#./}" ;; esac
  fi
  GF_OBS_DIR="$(dirname "$obs")"
  GF_OBS_FILE="$(basename "$obs")"
}

grafana_running() { # prints the running container's config label, fails when none runs
  local state
  state="$(docker container inspect --format '{{.State.Running}} {{index .Config.Labels "deskmates.config"}}' "$GRAFANA_CONTAINER" 2>/dev/null)" ||
    return 1
  [ "${state%% *}" = true ] || return 1
  printf '%s' "${state#* }"
}

# A state directory from decision 6 holds admin-password, and its Grafana database holds the user
# admin as Grafana's server administrator, whom the relay's header would then sign in.
grafana_state_current() {
  [ ! -e "$GRAFANA_STATE/admin-password" ] ||
    die "$GRAFANA_STATE predates ADR-0046 amendment 1: its Grafana user admin is a server administrator. Run stable.sh grafana stop, remove $GRAFANA_STATE (Grafana's own users and preferences; the dashboards come back from the release), then grafana init again"
}

grafana_url_hint() { # warns when the Gateway would not relay to this Grafana
  [ "$GF_URL" = "$GF_UPSTREAM" ] ||
    warn "set OBSERVABILITY_GRAFANA_URL=$GF_UPSTREAM in $SHARED/.env (got '${GF_URL}') and restart the Gateway to relay /analytics/ to this Grafana"
}

grafana_healthy() { # port
  local i
  for i in $(seq 1 "$GRAFANA_HEALTH_TIMEOUT"); do
    curl -fsS --max-time 2 "http://127.0.0.1:$1/analytics/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

cmd_grafana_init() {
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable"
  grafana_settings
  local rel; rel="$(grafana_release)"
  [ -f "$rel/images/grafana/Dockerfile" ] || die "$(basename "$rel") has no images/grafana; upgrade first"
  grafana_state_current
  mkdir -p "$GRAFANA_STATE/data"
  chmod 700 "$GRAFANA_STATE"
  local tag; tag="$(grafana_tag "$rel")"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    ok "image $tag already built"
  else
    # The only step that needs the registries: the official image and the plugin, at build time.
    say "building $tag"
    mkdir -p "$GRAFANA_STATE/logs"
    (cd "$rel" && GRAFANA_IMAGE="$tag" bash scripts/build-grafana-image.sh) \
      >"$GRAFANA_STATE/logs/build.log" 2>&1 ||
      { tail -20 "$GRAFANA_STATE/logs/build.log" >&2; die "Grafana image build failed; see $GRAFANA_STATE/logs/build.log"; }
    ok "built $tag"
  fi
  grafana_url_hint
  ok "next: stable.sh grafana start"
}

cmd_grafana_start() {
  grafana_settings
  local rel v; rel="$(grafana_release)"; v="$(basename "$rel")"
  grafana_state_current
  [ -d "$GRAFANA_STATE/data" ] || die "run stable.sh grafana init first"
  local provisioning="$rel/observability/grafana/$GF_ENGINE"
  [ -d "$provisioning/provisioning" ] && [ -d "$provisioning/dashboards" ] ||
    die "$v has no Grafana provisioning for $GF_ENGINE ($provisioning)"
  local tag image; tag="$(grafana_tag "$rel")"
  image="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)" ||
    die "image $tag is not on this host; run stable.sh grafana init"
  [ -d "$GF_OBS_DIR" ] || die "$GF_OBS_DIR does not exist; start the Gateway with OBSERVABILITY_SINK=sqlite first"
  [ -f "$GF_OBS_DIR/$GF_OBS_FILE" ] || warn "$GF_OBS_DIR/$GF_OBS_FILE does not exist yet; panels stay empty until the Gateway writes it"

  # Everything the container is created from; a running container with the same value is left alone.
  local config
  config="$(printf '%s\n' "$image" "$v" "$GF_ENGINE" "$GF_PORT" auth-proxy-v1 "$GF_OBS_DIR" "$GF_OBS_FILE" "$(id -u):$(id -g)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("node:crypto").createHash("sha256").update(s).digest("hex").slice(0,16)))')"
  local running
  if running="$(grafana_running)" && [ "$running" = "$config" ]; then
    ok "Grafana already runs $v on port $GF_PORT; nothing to change"
    return 0
  fi
  docker rm -f "$GRAFANA_CONTAINER" >/dev/null 2>&1 || true
  say "starting Grafana for $v ($GF_ENGINE) on port $GF_PORT"
  local args=(
    run -d --name "$GRAFANA_CONTAINER" --restart unless-stopped --network host
    --user "$(id -u):$(id -g)" --label "deskmates.config=$config" --label "deskmates.release=$v"
    # Amendment 1 decision 11: loopback only, served from the Gateway's /analytics/ sub path.
    -e GF_SERVER_HTTP_ADDR=127.0.0.1 -e "GF_SERVER_HTTP_PORT=$GF_PORT"
    -e "GF_SERVER_ROOT_URL=$GF_UPSTREAM/analytics/" -e GF_SERVER_SERVE_FROM_SUB_PATH=true
    # Decision 12: the relay's header is the only sign-in; its one user, admin, is a Viewer.
    -e GF_AUTH_PROXY_ENABLED=true -e GF_AUTH_PROXY_HEADER_NAME=X-WEBAUTH-USER
    -e GF_AUTH_PROXY_HEADER_PROPERTY=username -e GF_AUTH_PROXY_AUTO_SIGN_UP=true
    -e "GF_AUTH_PROXY_WHITELIST=127.0.0.1, ::1"
    -e GF_USERS_AUTO_ASSIGN_ORG=true -e GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer
    -e GF_USERS_ALLOW_SIGN_UP=false -e GF_USERS_ALLOW_ORG_CREATE=false
    -e GF_SECURITY_DISABLE_INITIAL_ADMIN_CREATION=true
    -e GF_AUTH_DISABLE_LOGIN_FORM=true -e GF_AUTH_DISABLE_SIGNOUT_MENU=true
    -e GF_AUTH_BASIC_ENABLED=false -e GF_AUTH_ANONYMOUS_ENABLED=false
    # Decision 15: no Grafana Live; the relay upgrades no WebSocket.
    -e GF_LIVE_MAX_CONNECTIONS=0
    -e GF_ANALYTICS_REPORTING_ENABLED=false -e GF_ANALYTICS_CHECK_FOR_UPDATES=false
    -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false -e GF_PLUGINS_PREINSTALL_DISABLED=true
    -e "DESKMATES_OBS_FILE=$GF_OBS_FILE"
    -e GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/deskmates-dashboards/agent-runs.json
    -v "$GRAFANA_STATE/data:/var/lib/grafana"
    # The directory, not the file: a reader of a WAL database needs the -wal and -shm files.
    -v "$GF_OBS_DIR:/var/lib/deskmates-obs:ro"
    -v "$provisioning/provisioning/datasources:/etc/grafana/provisioning/datasources:ro"
    -v "$provisioning/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro"
    -v "$provisioning/dashboards:/var/lib/deskmates-dashboards:ro"
  )
  docker "${args[@]}" "$image" >/dev/null
  if grafana_healthy "$GF_PORT"; then
    ok "Grafana is up on 127.0.0.1:$GF_PORT; the root opens it as Analytics, <Deskmates address>/analytics/"
    grafana_url_hint
    return 0
  fi
  docker logs --tail 30 "$GRAFANA_CONTAINER" >&2 || true
  die "Grafana did not answer /analytics/api/health on port $GF_PORT within ${GRAFANA_HEALTH_TIMEOUT}s"
}

cmd_grafana_stop() {
  if docker container inspect "$GRAFANA_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$GRAFANA_CONTAINER" >/dev/null
    ok "Grafana stopped; its state stays in $GRAFANA_STATE"
  else
    ok "Grafana is not running"
  fi
}

cmd_grafana_status() {
  local release
  release="$(docker container inspect --format '{{index .Config.Labels "deskmates.release"}}' "$GRAFANA_CONTAINER" 2>/dev/null)" ||
    { echo "grafana  not running"; return 0; }
  grafana_settings
  if grafana_running >/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$GF_PORT/analytics/api/health" >/dev/null 2>&1; then
    echo "grafana  running $release on 127.0.0.1:$GF_PORT, healthy"
  elif grafana_running >/dev/null; then
    echo "grafana  running $release on 127.0.0.1:$GF_PORT, not answering /analytics/api/health"
  else
    echo "grafana  stopped ($release)"
  fi
  [ "$release" = "$(current_version)" ] || echo "grafana  current release is $(current_version); run stable.sh grafana start"
  if [ "$GF_URL" = "$GF_UPSTREAM" ]; then echo "grafana  relayed by the Gateway at /analytics/ (OBSERVABILITY_GRAFANA_URL=$GF_URL)"
  else echo "grafana  not relayed: OBSERVABILITY_GRAFANA_URL is '${GF_URL}', expected $GF_UPSTREAM"
  fi
}

cmd_grafana() {
  case "${1:-}" in
    init) cmd_grafana_init ;;
    start) cmd_grafana_start ;;
    stop) cmd_grafana_stop ;;
    status) cmd_grafana_status ;;
    *) die "usage: $0 grafana init | start | stop | status" ;;
  esac
}

# --- searxng (ADR-0049 decision 14) --------------------------------------------------------------

# One container on the host network, beside the Gateway like Grafana: the Gateway's upgrades and
# rollbacks never touch it. It listens on 127.0.0.1 only; the Gateway's search proxy is its one
# client and no workspace container can reach it. The secret key lives in searxng/env, passed with
# --env-file so it is never on a command line.
SEARXNG_STATE="$ROOT/searxng"
SEARXNG_CONTAINER="${SEARXNG_CONTAINER:-deskmates-stable-searxng}"
SEARXNG_HEALTH_TIMEOUT="${SEARXNG_HEALTH_TIMEOUT:-60}"

searxng_release() { # prints the current release directory
  local v; v="$(current_version)"
  [ -n "$v" ] || die "no current release; activate one before SearXNG"
  printf '%s' "$RELEASES/$v"
}

searxng_tag() { # release-dir
  (cd "$1" && node scripts/image-tag.mjs searxng --arch "${IMAGE_ARCH:-amd64}")
}

# Reads the settings from shared/.env into SX_* shell variables.
searxng_settings() {
  [ -f "$SHARED/.env" ] || die "no $SHARED/.env; run init first"
  SX_PORT="$(env_opt SEARCH_PORT)"; SX_PORT="${SX_PORT:-18710}"
  [[ "$SX_PORT" =~ ^[0-9]+$ ]] && [ "$SX_PORT" -ge 1 ] && [ "$SX_PORT" -le 65535 ] ||
    die "SEARCH_PORT must be a port number, got '$SX_PORT'"
  SX_URL="$(env_opt SEARCH_URL)"
  # What the Gateway's search proxy calls: SearXNG's own loopback origin.
  SX_UPSTREAM="http://127.0.0.1:$SX_PORT"
}

searxng_running() { # prints the running container's config label, fails when none runs
  local state
  state="$(docker container inspect --format '{{.State.Running}} {{index .Config.Labels "deskmates.config"}}' "$SEARXNG_CONTAINER" 2>/dev/null)" ||
    return 1
  [ "${state%% *}" = true ] || return 1
  printf '%s' "${state#* }"
}

searxng_url_hint() { # warns when the Gateway would not search through this SearXNG
  [ "$SX_URL" = "$SX_UPSTREAM" ] ||
    warn "set SEARCH_URL=$SX_UPSTREAM in $SHARED/.env (got '${SX_URL}') and restart the Gateway to search through this SearXNG; each workspace's web search switch stays off until an Owner or Admin turns it on"
}

searxng_healthy() { # port
  local i
  for i in $(seq 1 "$SEARXNG_HEALTH_TIMEOUT"); do
    curl -fsS --max-time 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

cmd_searxng_init() {
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable"
  searxng_settings
  local rel; rel="$(searxng_release)"
  [ -f "$rel/images/searxng/Dockerfile" ] || die "$(basename "$rel") has no images/searxng; upgrade first"
  mkdir -p "$SEARXNG_STATE/cache"
  chmod 700 "$SEARXNG_STATE"
  if [ -f "$SEARXNG_STATE/env" ]; then
    ok "secret key kept in $SEARXNG_STATE/env"
  else
    (umask 077; printf 'SEARXNG_SECRET=%s\n' "$(openssl rand -hex 32)" > "$SEARXNG_STATE/env")
    ok "secret key written to $SEARXNG_STATE/env"
  fi
  chmod 600 "$SEARXNG_STATE/env"
  local tag; tag="$(searxng_tag "$rel")"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    ok "image $tag already built"
  else
    # The only step that needs the registry: the official image, at build time.
    say "building $tag"
    mkdir -p "$SEARXNG_STATE/logs"
    (cd "$rel" && SEARXNG_IMAGE="$tag" bash scripts/build-searxng-image.sh) \
      >"$SEARXNG_STATE/logs/build.log" 2>&1 ||
      { tail -20 "$SEARXNG_STATE/logs/build.log" >&2; die "SearXNG image build failed; see $SEARXNG_STATE/logs/build.log"; }
    ok "built $tag"
  fi
  searxng_url_hint
  ok "next: stable.sh searxng start"
}

cmd_searxng_start() {
  searxng_settings
  local rel v; rel="$(searxng_release)"; v="$(basename "$rel")"
  [ -f "$SEARXNG_STATE/env" ] || die "run stable.sh searxng init first"
  local tag image; tag="$(searxng_tag "$rel")"
  image="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)" ||
    die "image $tag is not on this host; run stable.sh searxng init"
  # Everything the container is created from; a running container with the same value is left alone.
  local config
  config="$(printf '%s\n' "$image" "$v" "$SX_PORT" loopback-v1 "$(id -u):$(id -g)" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("node:crypto").createHash("sha256").update(s).digest("hex").slice(0,16)))')"
  local running
  if running="$(searxng_running)" && [ "$running" = "$config" ]; then
    ok "SearXNG already runs $v on port $SX_PORT; nothing to change"
    return 0
  fi
  docker rm -f "$SEARXNG_CONTAINER" >/dev/null 2>&1 || true
  say "starting SearXNG for $v on port $SX_PORT"
  local args=(
    run -d --name "$SEARXNG_CONTAINER" --restart unless-stopped --network host
    --user "$(id -u):$(id -g)" --label "deskmates.config=$config" --label "deskmates.release=$v"
    --env-file "$SEARXNG_STATE/env"
    -e SEARXNG_BIND_ADDRESS=127.0.0.1 -e "SEARXNG_PORT=$SX_PORT"
    -v "$SEARXNG_STATE/cache:/var/cache/searxng"
  )
  docker "${args[@]}" "$image" >/dev/null
  if searxng_healthy "$SX_PORT"; then
    ok "SearXNG is up on 127.0.0.1:$SX_PORT"
    searxng_url_hint
    return 0
  fi
  docker logs --tail 30 "$SEARXNG_CONTAINER" >&2 || true
  die "SearXNG did not answer /healthz on port $SX_PORT within ${SEARXNG_HEALTH_TIMEOUT}s"
}

cmd_searxng_stop() {
  if docker container inspect "$SEARXNG_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$SEARXNG_CONTAINER" >/dev/null
    ok "SearXNG stopped; its secret and cache stay in $SEARXNG_STATE"
  else
    ok "SearXNG is not running"
  fi
}

cmd_searxng_status() {
  local release
  release="$(docker container inspect --format '{{index .Config.Labels "deskmates.release"}}' "$SEARXNG_CONTAINER" 2>/dev/null)" ||
    { echo "searxng  not running"; return 0; }
  searxng_settings
  if searxng_running >/dev/null && curl -fsS --max-time 2 "http://127.0.0.1:$SX_PORT/healthz" >/dev/null 2>&1; then
    echo "searxng  running $release on 127.0.0.1:$SX_PORT, healthy"
  elif searxng_running >/dev/null; then
    echo "searxng  running $release on 127.0.0.1:$SX_PORT, not answering /healthz"
  else
    echo "searxng  stopped ($release)"
  fi
  [ "$release" = "$(current_version)" ] || echo "searxng  current release is $(current_version); run stable.sh searxng start"
  if [ "$SX_URL" = "$SX_UPSTREAM" ]; then echo "searxng  used by the Gateway (SEARCH_URL=$SX_URL)"
  else echo "searxng  not used: SEARCH_URL is '${SX_URL}', expected $SX_UPSTREAM"
  fi
}

cmd_searxng() {
  case "${1:-}" in
    init) cmd_searxng_init ;;
    start) cmd_searxng_start ;;
    stop) cmd_searxng_stop ;;
    status) cmd_searxng_status ;;
    *) die "usage: $0 searxng init | start | stop | status" ;;
  esac
}

case "${1:-}" in
  init) cmd_init ;;
  install) cmd_install "${2:-}" ;;
  verify) cmd_verify "${2:-}" ;;
  activate) cmd_activate "${2:-}" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  grafana) cmd_grafana "${2:-}" ;;
  searxng) cmd_searxng "${2:-}" ;;
  *) die "usage: $0 init | install vX.Y.Z | verify vX.Y.Z | activate vX.Y.Z | rollback | status | grafana init|start|stop|status | searxng init|start|stop|status" ;;
esac
