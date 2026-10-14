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
#                                 rolls back by itself when the new release does not come up
#   stable.sh rollback            previous release plus the DB backup taken when leaving it
#   stable.sh status
#
# Layout under DESKMATES_STABLE_ROOT (default ~/Data/deskmates-stable):
#   releases/<v>/              extracted source of one tag + release-manifest.json + .release/
#   current -> releases/<v>    what the unit runs
#   shared/.env                0600, owned by humans: model endpoint, secrets key, operator token
#   shared/release.env         written here on every switch: release, image IDs, UI directory
#   shared/data/               the Gateway database
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
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-600}"
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
    (cd "$rel" && docker build -f images/workspace-base/Dockerfile -t "$base_tag" images/workspace-base) \
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

drain() {
  systemctl --user is-active --quiet "$UNIT" || return 0
  ports
  local waited=0 body n
  while :; do
    if ! body="$(api /api/runtime 2>/dev/null)"; then
      warn "the running Gateway has no /api/runtime; stopping without draining"
      return 0
    fi
    n="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).activeRuns))' "$body")"
    [ "$n" = "0" ] && { ok "no active runs"; return 0; }
    [ "$waited" -ge "$DRAIN_TIMEOUT" ] && break
    say "waiting for $n active run(s) to finish ($waited/${DRAIN_TIMEOUT}s)"
    sleep 10; waited=$((waited + 10))
  done
  [ "${FORCE:-}" = "1" ] || die "$n run(s) still active after ${DRAIN_TIMEOUT}s; retry later or FORCE=1"
  warn "FORCE=1: stopping with $n active run(s)"
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
  done
}

case "${1:-}" in
  init) cmd_init ;;
  install) cmd_install "${2:-}" ;;
  verify) cmd_verify "${2:-}" ;;
  activate) cmd_activate "${2:-}" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) die "usage: $0 init | install vX.Y.Z | verify vX.Y.Z | activate vX.Y.Z | rollback | status" ;;
esac
