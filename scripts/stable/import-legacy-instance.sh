#!/usr/bin/env bash
# Take over a stateful installation that ran under a former product name, keeping its database,
# workspace volumes and settings (docs/runbooks/stable-release.md, "Taking over an installation
# that ran under a former product name"). Run it on the stable host, from the shipped release:
#
#   import-legacy-instance.sh prepare vX.Y.Z   copy the legacy shared/.env into this root with its
#                                              env prefix renamed, then stable.sh init
#   import-legacy-instance.sh cutover vX.Y.Z   stop the legacy unit, back up its database, copy the
#                                              database and every workspace volume under the new
#                                              names, forget saved SDK sessions, stable.sh activate
#   import-legacy-instance.sh retire           remove the legacy workspace containers and networks,
#                                              disable the legacy unit (volumes stay for rollback)
#
# Environment (required): LEGACY_ROOT   the legacy root, e.g. ~/Data/<former>-stable
#                         LEGACY_UNIT   its systemd user unit, e.g. <former>-stable-gateway.service
#                         LEGACY_PREFIX the former product's lower-case name: its env prefix
#                                       (<FORMER>_*), Docker label (<former>.workspace) and
#                                       resource prefix (<former>-ws-*, <former>-<ws>-profile)
# Optional: DESKMATES_STABLE_ROOT (default ~/Data/deskmates-stable), DRY_RUN=1 (print the changes,
# touch nothing), FORCE=1 (cut over with active legacy runs), SKIP_T2=1 (passed to activate),
# COPY_IMAGE (any image with cp; default node:22-bookworm-slim, already on the host for egress).
#
# Rollback: start the legacy unit again; its root, database backup and volumes are untouched
# until `retire`, and even `retire` keeps the volumes.
set -euo pipefail

ROOT="${DESKMATES_STABLE_ROOT:-$HOME/Data/deskmates-stable}"
SHARED="$ROOT/shared"
RELEASES="$ROOT/releases"
UNIT="deskmates-stable-gateway.service"
COPY_IMAGE="${COPY_IMAGE:-node:22-bookworm-slim}"
NEW_PREFIX="deskmates"

say()  { printf '==> %s\n' "$*"; }
ok()   { printf ' ok  %s\n' "$*"; }
warn() { printf 'warn %s\n' "$*" >&2; }
die()  { printf 'error %s\n' "$*" >&2; exit 1; }
run()  { if [ "${DRY_RUN:-}" = "1" ]; then printf 'dry  %s\n' "$*"; else "$@"; fi; }

need_legacy() {
  [ -n "${LEGACY_ROOT:-}" ] || die "LEGACY_ROOT is not set"
  [ -n "${LEGACY_UNIT:-}" ] || die "LEGACY_UNIT is not set"
  [[ "${LEGACY_PREFIX:-}" =~ ^[a-z][a-z0-9]*$ ]] || die "LEGACY_PREFIX must be the former product's lower-case name"
  [ -f "$LEGACY_ROOT/shared/.env" ] || die "$LEGACY_ROOT/shared/.env not found"
  LEGACY_PREFIX_UPPER="$(printf '%s' "$LEGACY_PREFIX" | tr '[:lower:]' '[:upper:]')"
}

check_version() {
  [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a version like v0.7.0, got '${1:-}'"
}

env_get() { # file key
  grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- |
    sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

db_path() { # env-file shared-dir
  local db; db="$(env_get "$1" GATEWAY_DB)"; db="${db:-./data/gateway.sqlite}"
  case "$db" in /*) echo "$db" ;; *) echo "$2/${db#./}" ;; esac
}

legacy_active_runs() {
  local port token
  port="$(env_get "$LEGACY_ROOT/shared/.env" OPERATOR_PORT)"
  token="$(env_get "$LEGACY_ROOT/shared/.env" GATEWAY_OPERATOR_TOKEN)"
  curl -fsS --max-time 5 -H "authorization: Bearer $token" "http://127.0.0.1:${port:-8081}/api/runtime" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).activeRuns)))'
}

# Workspace ids from a database, read with the release's own better-sqlite3 (read-only).
workspace_ids() { # release-dir db
  (cd "$1" && node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { readonly: true });
    for (const r of db.prepare("select id from workspaces order by created_at").all()) console.log(r.id);
  ' "$2")
}

# --- prepare -------------------------------------------------------------------------------------

cmd_prepare() {
  local v="$1"; check_version "$v"; need_legacy
  local rel="$RELEASES/$v"
  [ -f "$rel/scripts/stable/stable.sh" ] || die "$v is not shipped to $RELEASES; run ship.sh first"
  if [ -f "$SHARED/.env" ] && [ "${FORCE:-}" != "1" ]; then
    die "$SHARED/.env exists; remove it or FORCE=1 to rebuild it from the legacy file"
  fi
  say "copying $LEGACY_ROOT/shared/.env to $SHARED/.env with ${LEGACY_PREFIX_UPPER}_* renamed to DESKMATES_*"
  run mkdir -p "$SHARED"
  if [ "${DRY_RUN:-}" = "1" ]; then
    grep -E "^${LEGACY_PREFIX_UPPER}_" "$LEGACY_ROOT/shared/.env" | cut -d= -f1 | sed 's/^/dry  rename /' || true
  else
    (umask 077; sed -E \
      -e "s/^${LEGACY_PREFIX_UPPER}_/DESKMATES_/" \
      -e "/^(WORKSPACE_IMAGE|EGRESS_PROXY_IMAGE|WEB_DIST_DIR|CHANNEL_PLUGIN_MANIFEST|DESKMATES_RELEASE)=/d" \
      "$LEGACY_ROOT/shared/.env" >"$SHARED/.env")
    chmod 600 "$SHARED/.env"
  fi
  local k
  for k in GATEWAY_SECRETS_KEY GATEWAY_OPERATOR_TOKEN MODEL_BASE_URL DEFAULT_MODEL CHEAP_MODEL GATEWAY_PORT OPERATOR_PORT; do
    [ "${DRY_RUN:-}" = "1" ] || [ -n "$(env_get "$SHARED/.env" "$k")" ] || warn "$k is empty in $SHARED/.env"
  done
  ok "same secrets key, operator token and ports as the legacy instance (TLS proxy and clients keep working)"
  say "stable.sh init (directories and the $UNIT unit; the legacy unit keeps running)"
  run bash "$rel/scripts/stable/stable.sh" init
  ok "next: stable.sh install $v, stable.sh verify $v, then import-legacy-instance.sh cutover $v in a quiet window"
}

# --- cutover -------------------------------------------------------------------------------------

cmd_cutover() {
  local v="$1"; check_version "$v"; need_legacy
  local rel="$RELEASES/$v" meta="$RELEASES/$v/.release"
  [ -f "$meta/installed" ] || die "$v is not installed"
  [ -f "$meta/t2.passed" ] || [ "${SKIP_T2:-}" = "1" ] || die "T2 has not passed for $v; run verify (or SKIP_T2=1)"
  [ -f "$SHARED/.env" ] || die "no $SHARED/.env; run prepare first"
  ! systemctl --user is-active --quiet "$UNIT" || die "$UNIT is already running; nothing to import"
  local new_db legacy_db
  new_db="$(db_path "$SHARED/.env" "$SHARED")"
  legacy_db="$(db_path "$LEGACY_ROOT/shared/.env" "$LEGACY_ROOT/shared")"
  [ -f "$legacy_db" ] || die "legacy database $legacy_db not found"
  if [ -s "$new_db" ] && [ "${FORCE:-}" != "1" ]; then
    die "$new_db exists and is not empty; this root already has data (FORCE=1 overwrites it)"
  fi

  if systemctl --user is-active --quiet "$LEGACY_UNIT"; then
    local n; n="$(legacy_active_runs || echo unknown)"
    if [ "$n" != "0" ] && [ "${FORCE:-}" != "1" ]; then
      die "legacy instance reports $n active run(s); wait for them or FORCE=1"
    fi
    say "stopping $LEGACY_UNIT"
    run systemctl --user stop "$LEGACY_UNIT"
  else
    warn "$LEGACY_UNIT is not running; importing the database as it is on disk"
  fi

  local stamp backup; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$LEGACY_ROOT/backups/$stamp-handover-to-$v"
  say "backing up the legacy database to $backup"
  run mkdir -p "$backup"
  local f
  for f in "$legacy_db" "$legacy_db-wal" "$legacy_db-shm"; do [ -f "$f" ] && run cp -p "$f" "$backup/"; done

  say "copying the database to $new_db"
  run mkdir -p "$(dirname "$new_db")"
  run rm -f "$new_db" "$new_db-wal" "$new_db-shm"
  for f in "$legacy_db" "$legacy_db-wal" "$legacy_db-shm"; do
    [ -f "$f" ] && run cp -p "$f" "$(dirname "$new_db")/$(basename "$new_db")${f#"$legacy_db"}"
  done

  # Saved SDK sessions name the former tool namespace and container targets; the naming runbook
  # says they must not be resumed. Forgetting them starts a fresh session per bot and thread;
  # thread messages, memory and files are untouched.
  say "forgetting saved SDK sessions (bot_sessions)"
  if [ "${DRY_RUN:-}" = "1" ]; then
    printf 'dry  delete from bot_sessions in %s\n' "$legacy_db"
  else
    (cd "$rel" && node -e '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1]);
      const n = db.prepare("delete from bot_sessions").run().changes;
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      console.log(` ok  forgot ${n} saved session(s)`);
    ' "$new_db")
  fi

  say "copying workspace volumes ${LEGACY_PREFIX}-<ws>-{profile,work,home} to ${NEW_PREFIX}-<ws>-*"
  local ws suffix src dst copied=0 skipped=0
  while IFS= read -r ws; do
    [ -n "$ws" ] || continue
    for suffix in profile work home; do
      src="${LEGACY_PREFIX}-${ws}-${suffix}"; dst="${NEW_PREFIX}-${ws}-${suffix}"
      if ! docker volume inspect "$src" >/dev/null 2>&1; then
        warn "no legacy volume $src (workspace never started?)"; continue
      fi
      if docker volume inspect "$dst" >/dev/null 2>&1 &&
        [ -n "$(docker run --rm -v "$dst:/to:ro" "$COPY_IMAGE" sh -c 'ls -A /to' 2>/dev/null)" ]; then
        warn "$dst exists and is not empty; left as is"; skipped=$((skipped + 1)); continue
      fi
      # The provider refuses a volume whose ownership labels it did not write (docker-provider.ts
      # ensureWorkspaceVolume), so the copy carries the legacy labels under the new prefix:
      # <former>.managed/.workspace/.tenant become deskmates.managed/.workspace/.tenant.
      local labels=()
      while IFS= read -r kv; do
        [ -n "$kv" ] && labels+=(--label "${NEW_PREFIX}.${kv#"${LEGACY_PREFIX}".}")
      done < <(docker volume inspect -f '{{range $k, $v := .Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$src" |
        grep "^${LEGACY_PREFIX}\." || true)
      [ "${#labels[@]}" -gt 0 ] || warn "$src carries no ${LEGACY_PREFIX}.* label; $dst gets none and the new Gateway will refuse it"
      run docker volume create "${labels[@]}" "$dst" >/dev/null
      run docker run --rm -v "$src:/from:ro" -v "$dst:/to" "$COPY_IMAGE" sh -c 'cp -a /from/. /to/'
      copied=$((copied + 1))
    done
  done < <(workspace_ids "$rel" "$legacy_db")
  ok "volumes copied: $copied, skipped: $skipped"

  say "activating $v (stable.sh backs the imported database up again under $ROOT/backups)"
  run env SKIP_T2="${SKIP_T2:-}" bash "$rel/scripts/stable/stable.sh" activate "$v"
  ok "cut over; the legacy unit is stopped but still enabled. Verify the UI, then: import-legacy-instance.sh retire"
}

# --- retire --------------------------------------------------------------------------------------

cmd_retire() {
  need_legacy
  local legacy_db; legacy_db="$(db_path "$LEGACY_ROOT/shared/.env" "$LEGACY_ROOT/shared")"
  local rel; rel="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  [ -n "$rel" ] && [ -d "$rel" ] || die "$ROOT/current does not point at a release; cut over first"
  systemctl --user is-active --quiet "$UNIT" || die "$UNIT is not running; retire only after a verified cutover"
  say "removing legacy workspace containers and networks for the workspaces in $legacy_db"
  local ws
  while IFS= read -r ws; do
    [ -n "$ws" ] || continue
    for c in "${LEGACY_PREFIX}-ws-${ws}" "${LEGACY_PREFIX}-egress-${ws}"; do
      docker container inspect "$c" >/dev/null 2>&1 && run docker rm -f "$c" >/dev/null && ok "removed $c" || true
    done
    docker network inspect "${LEGACY_PREFIX}-net-${ws}" >/dev/null 2>&1 &&
      run docker network rm "${LEGACY_PREFIX}-net-${ws}" >/dev/null && ok "removed network ${LEGACY_PREFIX}-net-${ws}" || true
  done < <(workspace_ids "$rel" "$legacy_db")
  local left; left="$(docker ps -a --filter "label=${LEGACY_PREFIX}.workspace" --format '{{.Names}}' | tr '\n' ' ')"
  [ -z "$left" ] || warn "other containers still carry the ${LEGACY_PREFIX}.workspace label (not ours to remove): $left"
  say "disabling $LEGACY_UNIT"
  run systemctl --user disable --now "$LEGACY_UNIT"
  ok "legacy volumes ${LEGACY_PREFIX}-<ws>-* and $LEGACY_ROOT are kept for rollback; remove them by hand later"
}

case "${1:-}" in
  prepare) cmd_prepare "${2:-}" ;;
  cutover) cmd_cutover "${2:-}" ;;
  retire) cmd_retire ;;
  *) die "usage: $0 prepare vX.Y.Z | cutover vX.Y.Z | retire   (LEGACY_ROOT, LEGACY_UNIT, LEGACY_PREFIX; DRY_RUN=1)" ;;
esac
