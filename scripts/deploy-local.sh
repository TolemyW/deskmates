#!/usr/bin/env bash
# One-command local deployment of the M0 stack for trying Deskmates by hand.
#
#   scripts/deploy-local.sh up       build what is missing, start everything, create a demo bot
#   scripts/deploy-local.sh down     stop the Gateway, the web UI and the golden site
#   scripts/deploy-local.sh status   what is running, and where
#   scripts/deploy-local.sh logs     tail the Gateway / web / golden-site logs
#   scripts/deploy-local.sh purge    down, then remove the SQLite DB, workspace containers and volumes
#   scripts/deploy-local.sh cron "*/2 * * * *" "<prompt>"   set the demo bot's cron entry (empty schedule clears it)
#   scripts/deploy-local.sh webhook '<body>'               deliver a webhook to the demo bot
#   scripts/deploy-local.sh runs                           the demo bot's last runs: trigger, status, reply
#
# `up` is idempotent: run it again after a code change and it rebuilds the workspace image and
# restarts the processes; the database and the demo bot are kept. Environment knobs:
#   GOLDEN_SITE=host|docker|off   how to run the Galaxy Ops Console (default host: a Node process
#                                 on this machine; docker needs node:22-alpine to be pullable)
#   EXTRA_EGRESS=a.com,*.b.com    extra hosts for the demo workspace's egress allowlist (read only
#                                 when the workspace is created; purge first to change it)
#   SKIP_IMAGE_BUILD=1            reuse the existing deskmates/workspace image
#   SKIP_INSTALL=1                do not run npm install
#
# Processes are started with nohup; PIDs live in data/run, logs in data/logs. Nothing here is a
# production deployment: the operator listener binds 127.0.0.1 with the .env credential
# (ADR-0006), noVNC is not published, and the golden site is a demo target.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN_DIR="$ROOT/data/run"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

CMD="${1:-up}"
GOLDEN_SITE="${GOLDEN_SITE:-host}"
GOLDEN_SITE_PORT="${GOLDEN_SITE_PORT:-4477}"
GOLDEN_SITE_CONTAINER="deskmates-golden-site"

# --- helpers -----------------------------------------------------------------------------------

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

# Read one key from .env without exporting the whole file.
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

pid_alive() { [ -f "$RUN_DIR/$1.pid" ] && kill -0 "$(cat "$RUN_DIR/$1.pid")" 2>/dev/null; }

start_bg() { # name, log, cwd, command...
  local name="$1" log="$2" cwd="$3"; shift 3
  if pid_alive "$name"; then
    say "restarting $name"
    stop_bg "$name"
  fi
  # The subshell execs into the command, so $! is the command's own pid (no wrapper to outlive it).
  (cd "$cwd" && exec nohup "$@" >>"$LOG_DIR/$log" 2>&1) &
  echo $! >"$RUN_DIR/$name.pid"
}

stop_bg() {
  local name="$1"
  if pid_alive "$name"; then
    local pid; pid="$(cat "$RUN_DIR/$name.pid")"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$pid" 2>/dev/null || true
    ok "stopped $name"
  fi
  rm -f "$RUN_DIR/$name.pid"
}

wait_http() { # url, seconds
  local url="$1" secs="${2:-60}"
  for _ in $(seq 1 "$((secs * 2))"); do
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# Operator API (ADR-0006): the /api routes live on the operator listener and need the Bearer
# credential from .env. The sandbox listener on GATEWAY_PORT serves only /v1, /internal, /healthz.
api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' -d "$body" "$OPERATOR_URL$path"
  else
    curl -fsS -X "$method" -H "authorization: Bearer $OPERATOR_TOKEN" "$OPERATOR_URL$path"
  fi
}

wait_api() { # seconds; the operator listener starts a moment after /healthz answers
  for _ in $(seq 1 "$((${1:-30} * 2))"); do
    curl -fsS --max-time 2 -H "authorization: Bearer $OPERATOR_TOKEN" "$OPERATOR_URL/api/workspaces" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

json_get() { # json-string, js-expression over `j`
  node -e 'const j=JSON.parse(process.argv[1]);const v=eval(process.argv[2]);process.stdout.write(v===undefined?"":String(v))' "$1" "$2"
}

# --- preflight -----------------------------------------------------------------------------------

preflight() {
  say "preflight"
  command -v node >/dev/null || die "node is not installed (need Node 22+)"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node 22+ required, found $(node -v)"
  command -v npm  >/dev/null || die "npm is not installed"
  command -v curl >/dev/null || die "curl is not installed"
  command -v docker >/dev/null || die "docker is not installed"

  if ! docker info >/dev/null 2>&1; then
    if command -v colima >/dev/null; then
      say "docker is down; starting colima"
      colima start
      docker info >/dev/null 2>&1 || die "docker still unreachable after colima start"
    else
      die "docker daemon unreachable; start Docker Desktop or colima"
    fi
  fi
  ok "node $(node -v), docker reachable"

  if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    warn ".env did not exist; created it from .env.example"
  fi
  if [ -z "$(env_get GATEWAY_SECRETS_KEY)" ]; then
    local key; key="$(openssl rand -base64 32)"
    perl -pi -e "s|^GATEWAY_SECRETS_KEY=.*|GATEWAY_SECRETS_KEY=$key|" .env
    ok "generated GATEWAY_SECRETS_KEY"
  fi
  if [ -z "$(env_get GATEWAY_OPERATOR_TOKEN)" ]; then
    # loadConfig refuses to start without one of at least 32 bytes; base64 of 32 bytes is 44.
    local tok; tok="$(openssl rand -base64 32 | tr '+/' '-_')"
    perl -pi -e "s|^GATEWAY_OPERATOR_TOKEN=.*|GATEWAY_OPERATOR_TOKEN=$tok|" .env
    grep -q '^GATEWAY_OPERATOR_TOKEN=' .env || echo "GATEWAY_OPERATOR_TOKEN=$tok" >>.env
    ok "generated GATEWAY_OPERATOR_TOKEN (the UI asks for it; it is in .env)"
  fi
  local missing=()
  for k in MODEL_BASE_URL MODEL_AUTH_TOKEN DEFAULT_MODEL CHEAP_MODEL; do
    [ -n "$(env_get "$k")" ] || missing+=("$k")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "fill these in .env and rerun: ${missing[*]}"
  fi

  GATEWAY_PORT="$(env_get GATEWAY_PORT)"; GATEWAY_PORT="${GATEWAY_PORT:-8080}"
  WEB_PORT="$(env_get WEB_PORT)";         WEB_PORT="${WEB_PORT:-5173}"
  WORKSPACE_IMAGE="$(env_get WORKSPACE_IMAGE)"; WORKSPACE_IMAGE="${WORKSPACE_IMAGE:-deskmates/workspace:dev}"
  EGRESS_PROXY_IMAGE="$(env_get EGRESS_PROXY_IMAGE)"; EGRESS_PROXY_IMAGE="${EGRESS_PROXY_IMAGE:-deskmates/egress-proxy:dev}"
  operator_env
  GATEWAY_URL="http://localhost:$GATEWAY_PORT"
  WEB_URL="http://localhost:$WEB_PORT"
  ok ".env: gateway :$GATEWAY_PORT, operator :$OPERATOR_PORT, web :$WEB_PORT, images $WORKSPACE_IMAGE + $EGRESS_PROXY_IMAGE, model $(env_get DEFAULT_MODEL) / $(env_get CHEAP_MODEL)"
}

operator_env() {
  OPERATOR_PORT="$(env_get OPERATOR_PORT)"; OPERATOR_PORT="${OPERATOR_PORT:-8081}"
  OPERATOR_URL="http://localhost:$OPERATOR_PORT"
  OPERATOR_TOKEN="$(env_get GATEWAY_OPERATOR_TOKEN)"
  [ -n "$OPERATOR_TOKEN" ] || die "GATEWAY_OPERATOR_TOKEN is empty in .env; run up once to generate it"
}

# --- build ---------------------------------------------------------------------------------------

build() {
  if [ "${SKIP_INSTALL:-}" != "1" ] && [ ! -f node_modules/.package-lock.json ]; then
    say "npm install"
    npm install
  fi

  say "building contracts, sandbox-docker, gateway, golden-site"
  npm run build -w packages/contracts
  npm run build -w packages/sandbox-docker
  npm run build -w packages/gateway
  npm run build -w packages/golden-site

  if [ "${SKIP_IMAGE_BUILD:-}" = "1" ]; then
    docker image inspect "$WORKSPACE_IMAGE" >/dev/null 2>&1 || die "SKIP_IMAGE_BUILD=1 but $WORKSPACE_IMAGE does not exist"
    docker image inspect "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || die "SKIP_IMAGE_BUILD=1 but $EGRESS_PROXY_IMAGE does not exist"
    ok "reusing $WORKSPACE_IMAGE and $EGRESS_PROXY_IMAGE"
  else
    say "building the workspace image $WORKSPACE_IMAGE (cached layers are reused)"
    WORKSPACE_IMAGE="$WORKSPACE_IMAGE" bash scripts/build-workspace-image.sh >"$LOG_DIR/image-build.log" 2>&1 \
      || { tail -20 "$LOG_DIR/image-build.log" >&2; die "image build failed; full log in data/logs/image-build.log"; }
    ok "built $WORKSPACE_IMAGE"
    # The workspace network is internal; this proxy is its only way out (images/egress/README.md).
    say "building the egress proxy image $EGRESS_PROXY_IMAGE"
    docker build -f images/egress/Dockerfile -t "$EGRESS_PROXY_IMAGE" . >"$LOG_DIR/egress-build.log" 2>&1 \
      || { tail -20 "$LOG_DIR/egress-build.log" >&2; die "egress proxy build failed; full log in data/logs/egress-build.log"; }
    ok "built $EGRESS_PROXY_IMAGE"
  fi
}

# --- golden site ---------------------------------------------------------------------------------

golden_site_up() {
  case "$GOLDEN_SITE" in
    off)
      warn "GOLDEN_SITE=off: no demo site; add your own host to the workspace egress allowlist"
      return ;;
    host)
      say "starting the Galaxy Ops Console on :$GOLDEN_SITE_PORT (host process)"
      start_bg golden-site golden-site.log "$ROOT" \
        env GOLDEN_SITE_HOST=0.0.0.0 GOLDEN_SITE_PORT="$GOLDEN_SITE_PORT" node "$ROOT/packages/golden-site/dist/serve.js"
      ;;
    docker)
      local version tag
      version="$(node -p 'require("./evals/tasks/deskbench-v1.json").site_version')"
      tag="galaxy-ops-console:$version"
      if ! docker image inspect "$tag" >/dev/null 2>&1; then
        say "building $tag"
        bash scripts/build-golden-site-image.sh >"$LOG_DIR/golden-site-build.log" 2>&1 \
          || { tail -10 "$LOG_DIR/golden-site-build.log" >&2; die "golden site image build failed (is node:22-alpine pullable?); use GOLDEN_SITE=host"; }
      fi
      docker rm -f "$GOLDEN_SITE_CONTAINER" >/dev/null 2>&1 || true
      say "starting $tag as $GOLDEN_SITE_CONTAINER on :$GOLDEN_SITE_PORT"
      docker run -d --name "$GOLDEN_SITE_CONTAINER" -p "$GOLDEN_SITE_PORT:4477" "$tag" >/dev/null
      ;;
    *) die "GOLDEN_SITE must be host, docker or off" ;;
  esac
  wait_http "http://localhost:$GOLDEN_SITE_PORT/api/state" 30 || die "golden site did not come up; see data/logs/golden-site.log"
  ok "golden site: http://localhost:$GOLDEN_SITE_PORT (the bot reaches it as http://host.docker.internal:$GOLDEN_SITE_PORT)"
}

golden_site_down() {
  stop_bg golden-site
  if docker container inspect "$GOLDEN_SITE_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$GOLDEN_SITE_CONTAINER" >/dev/null && ok "removed $GOLDEN_SITE_CONTAINER"
  fi
}

# --- gateway + web -------------------------------------------------------------------------------

gateway_up() {
  say "starting the Gateway on :$GATEWAY_PORT"
  # main() loads .env from the working directory and binds 0.0.0.0; sandboxes reach it at
  # host.docker.internal:<port> unless GATEWAY_BASE_URL says otherwise.
  start_bg gateway gateway.log "$ROOT" node "$ROOT/packages/gateway/dist/index.js"
  wait_http "$GATEWAY_URL/healthz" 30 || { tail -20 "$LOG_DIR/gateway.log" >&2; die "Gateway did not become healthy; see data/logs/gateway.log"; }
  wait_api 15 || { tail -20 "$LOG_DIR/gateway.log" >&2; die "operator listener on :$OPERATOR_PORT did not answer; see data/logs/gateway.log"; }
  ok "gateway: $GATEWAY_URL (sandbox), $OPERATOR_URL (operator API)"
}

web_up() {
  say "starting the web UI on :$WEB_PORT"
  # vite directly (not via npm run) so the pid we keep is vite's own; cwd is the package root.
  start_bg web web.log "$ROOT/packages/web" node "$ROOT/node_modules/.bin/vite" --host 127.0.0.1
  wait_http "$WEB_URL/" 60 || { tail -20 "$LOG_DIR/web.log" >&2; die "web UI did not come up; see data/logs/web.log"; }
  ok "web: $WEB_URL"
}

# --- demo bot ------------------------------------------------------------------------------------

# One workspace, one bot, one chat thread, created only when the database is empty. The
# workspace's egress allowlist holds the golden site's host and nothing else; SOUL.md is
# pre-seeded into the bot's home volume so the first run already knows the site and the account.
bootstrap() {
  local ws_json ws_count
  ws_json="$(api GET /api/workspaces)"
  ws_count="$(json_get "$ws_json" 'j.workspaces.length')"
  if [ "$ws_count" != "0" ]; then
    WS_ID="$(json_get "$ws_json" 'j.workspaces[0].id')"
    local threads; threads="$(api GET "/api/threads?workspaceId=$WS_ID")"
    THREAD_ID="$(json_get "$threads" 'j.threads[0]?.id')"
    ok "existing workspace $WS_ID kept"
    return
  fi

  say "creating the demo workspace, bot and thread"
  local hosts=()
  [ "$GOLDEN_SITE" != "off" ] && hosts+=("host.docker.internal")
  IFS=',' read -ra extra <<<"${EXTRA_EGRESS:-}"
  for h in "${extra[@]}"; do h="${h// /}"; [ -n "$h" ] && hosts+=("$h"); done
  local allow; allow="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${hosts[@]}")"
  ws_json="$(api POST /api/workspaces "{\"name\":\"demo\",\"egressAllowlist\":$allow}")"
  WS_ID="$(json_get "$ws_json" 'j.workspace.id')"
  local bot_json bot_id
  bot_json="$(api POST /api/bots "{\"name\":\"nova\",\"role\":\"operations assistant\",\"workspaceId\":\"$WS_ID\"}")"
  bot_id="$(json_get "$bot_json" 'j.bot.id')"
  # Shown once by the Gateway; kept here (0600) so `webhook` can deliver without rotating it.
  json_get "$bot_json" 'j.webhookToken' >"$RUN_DIR/webhook-token" && chmod 600 "$RUN_DIR/webhook-token"
  local thread_json
  thread_json="$(api POST /api/threads "{\"workspaceId\":\"$WS_ID\",\"botIds\":[\"$bot_id\"],\"title\":\"first chat\"}")"
  THREAD_ID="$(json_get "$thread_json" 'j.thread.id')"
  ok "workspace $WS_ID, bot nova ($bot_id), thread $THREAD_ID"

  if [ "$GOLDEN_SITE" != "off" ]; then
    # The Gateway mounts deskmates-<ws>-home at /home when it creates the container; writing the
    # volume now, through the workspace image itself, means no pull and no second image.
    say "seeding /home/nova/SOUL.md into volume deskmates-$WS_ID-home"
    docker run --rm -i --entrypoint /bin/sh -v "deskmates-$WS_ID-home:/home" "$WORKSPACE_IMAGE" \
      -c 'mkdir -p /home/nova && cat > /home/nova/SOUL.md' <<EOF
# nova

You are nova, an operations assistant for the Galaxy Ops Console at http://host.docker.internal:$GOLDEN_SITE_PORT.
You work through the browser tools. Open pages with browser_navigate, read them with
browser_snapshot, and act with browser_click, browser_type and browser_select_option.

## Accounts
- ops account: email ops@galaxy.test, password Galaxy#2026

## Rules
- When asked a question, give the answer on the last line of your reply as \`answer: <value>\`.
- If a tool call is denied or blocked, do not look for another way to achieve the same effect.
  Stop, and report in your reply exactly what was denied and why.
- Do only what the message asks. Do not change anything it did not ask you to change.
- Keep replies short.
EOF
    ok "SOUL.md seeded"
  fi
}

# --- commands ------------------------------------------------------------------------------------

cmd_up() {
  preflight
  build
  golden_site_up
  gateway_up
  web_up
  bootstrap

  echo
  say "Deskmates M0 is up"
  echo "  chat:        $WEB_URL/#/threads/${THREAD_ID:-}"
  echo "  credential:  the UI asks for the operator credential: GATEWAY_OPERATOR_TOKEN in .env"
  echo "  operator:    $OPERATOR_URL   (GET /api/workspaces, /api/runs, /api/events; Bearer token)"
  echo "  gateway:     $GATEWAY_URL   (sandbox-facing: /v1, /internal, /healthz)"
  if [ "$GOLDEN_SITE" != "off" ]; then
    echo "  golden site: http://localhost:$GOLDEN_SITE_PORT   login ops@galaxy.test / Galaxy#2026"
  fi
  echo "  logs:        scripts/deploy-local.sh logs   (workspace container: docker logs -f deskmates-ws-${WS_ID:-<id>})"
  echo
  echo "The workspace container is created on the first message; that first run takes a minute"
  echo "longer while Chromium and the SDK start. Things to type into the chat:"
  echo
  echo "    Log in to the console and tell me how many open tickets the dashboard shows."
  echo "    What is this month's revenue on the dashboard?"
  echo "    Place an order for customer C-0001: SKU-3, quantity 2.      <- L2: an approval card appears"
  echo
  echo "Approvals: the card shows up in the thread (and under #/approvals) with Allow once / Always /"
  echo "Deny. Keep the chat tab open: the Gateway counts you as online only while the UI's event"
  echo "stream is connected; with nobody online an L2 request parks the run at once. Answer within"
  echo "the short wait (5 min): resuming a parked browser click is a known open bug."
  echo
  echo "Triggers (API only; no UI screen yet):"
  echo '    scripts/deploy-local.sh cron "*/2 * * * *" "Log in and report the open ticket count."'
  echo "    scripts/deploy-local.sh webhook '{\"event\":\"ticket_created\",\"id\":\"T-0042\"}'"
  echo "    scripts/deploy-local.sh runs        # trigger, lane, status and reply of the last runs"
  echo
  echo "The M0 golden site has /login, /mfa, /dashboard and /checkout only; other modules return"
  echo "a 404 that says so. Every run is replayable from the message's link (#/runs/<id>): tool"
  echo "calls, screenshots, usage (unpriced unless the model is in the Gateway's price table)."
}

cmd_down() {
  stop_bg web
  stop_bg gateway
  golden_site_down
  ok "down (workspace containers are left running; use purge to remove them)"
}

cmd_status() {
  for n in gateway web golden-site; do
    if pid_alive "$n"; then ok "$n running (pid $(cat "$RUN_DIR/$n.pid"))"; else echo "     $n stopped"; fi
  done
  docker ps --filter "name=deskmates-" --format '  container {{.Names}}  {{.Status}}' 2>/dev/null || true
  operator_env
  if api GET /api/workspaces 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).workspaces)console.log(`  workspace ${w.id}  ${w.name}  egress=${JSON.stringify(w.egressAllowlist)}`)})'; then :; fi
}

cmd_logs() {
  tail -n 40 -F "$LOG_DIR"/gateway.log "$LOG_DIR"/web.log "$LOG_DIR"/golden-site.log 2>/dev/null
}

# --- triggers (API only in M1; the UI has no screen for them yet) --------------------------------

demo_bot() { # sets BOT_ID to the first bot of the first workspace
  preflight_light
  local ws; ws="$(api GET /api/workspaces)"
  local ws_id; ws_id="$(json_get "$ws" 'j.workspaces[0]?.id')"
  [ -n "$ws_id" ] || die "no workspace yet; run up first"
  local bots; bots="$(api GET "/api/bots?workspaceId=$ws_id")"
  BOT_ID="$(json_get "$bots" 'j.bots[0]?.id')"
  [ -n "$BOT_ID" ] || die "no bot in workspace $ws_id"
}

# Ports and URLs without the full preflight (no build, no docker checks).
preflight_light() {
  GATEWAY_PORT="$(env_get GATEWAY_PORT)"; GATEWAY_PORT="${GATEWAY_PORT:-8080}"
  GATEWAY_URL="http://localhost:$GATEWAY_PORT"
  operator_env
  curl --max-filesize 102400 -fsS --max-time 2 "$GATEWAY_URL/healthz" >/dev/null 2>&1 || die "Gateway is not running; run up first"
}

cmd_cron() {
  local schedule="${1-}" prompt="${2-}"
  demo_bot
  local entries='[]'
  if [ -n "$schedule" ]; then
    [ -n "$prompt" ] || die "usage: $0 cron '<5-field schedule>' '<prompt>'"
    entries="$(node -e 'console.log(JSON.stringify([{schedule:process.argv[1],prompt:process.argv[2]}]))' "$schedule" "$prompt")"
  fi
  api PATCH "/api/bots/$BOT_ID" "{\"cron\":$entries}" >/dev/null
  if [ -n "$schedule" ]; then
    ok "cron set on bot $BOT_ID: '$schedule' -> $prompt"
    echo "   the runner ticks once a minute (CRON_TIMEZONE in .env, default the Gateway's zone);"
    echo "   each firing is a background run: scripts/deploy-local.sh runs"
  else
    ok "cron cleared on bot $BOT_ID"
  fi
}

cmd_webhook() {
  local body="${1-}"
  [ -n "$body" ] || die "usage: $0 webhook '<body>'"
  demo_bot
  if [ ! -s "$RUN_DIR/webhook-token" ]; then
    # Older demo bots (created before this command existed) have no saved token: rotate once.
    api POST "/api/bots/$BOT_ID/webhook-token" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).webhookToken))' >"$RUN_DIR/webhook-token"
    chmod 600 "$RUN_DIR/webhook-token"
    warn "no saved webhook token; rotated one into data/run/webhook-token"
  fi
  local token; token="$(cat "$RUN_DIR/webhook-token")"
  local res; res="$(curl --max-filesize 102400 -fsS -X POST -H 'content-type: application/json' --data-binary "$body" "$OPERATOR_URL/hooks/$BOT_ID/$token")"
  ok "delivered: $res   (curl --max-filesize 102400 -X POST --data-binary '<body>' $OPERATOR_URL/hooks/$BOT_ID/<token>)"
}

cmd_runs() {
  demo_bot
  api GET "/api/runs?botId=$BOT_ID" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const runs=JSON.parse(s).runs.slice(-12);
      for(const r of runs){
        const reply=(r.summary&&r.summary.reply)||"";
        console.log(`${r.id}  ${String(r.triggerKind).padEnd(14)} ${String(r.lane).padEnd(11)} ${String(r.status).padEnd(18)} ${(r.createdAt||"").slice(11,19)}  ${reply.replace(/\s+/g," ").slice(0,90)}`);
      }
      if(!runs.length)console.log("no runs yet");
    })'
}

cmd_purge() {
  cmd_down
  local db; db="$(env_get GATEWAY_DB)"; db="${db:-./data/gateway.sqlite}"
  # Only the workspaces this instance's database knows. A Docker daemon can host other Deskmates
  # instances (the stable deployment on Testbox, other checkouts, test runs); selecting by a
  # `deskmates-` name prefix used to delete their containers and volumes too.
  local ws_ids=""
  if [ -f "$db" ]; then
    ws_ids="$(node -e '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      for (const r of db.prepare("SELECT id FROM workspaces").all()) console.log(r.id);
    ' "$db")" || die "could not read workspace ids from $db; nothing removed"
  fi
  local ws ids nets
  for ws in $ws_ids; do
    ids="$(docker ps -aq --filter "label=deskmates.workspace=$ws" 2>/dev/null || true)"
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null && ok "removed containers of $ws"; fi
    nets="$(docker network ls -q --filter "label=deskmates.workspace=$ws" 2>/dev/null || true)"
    if [ -n "$nets" ]; then docker network rm $nets >/dev/null && ok "removed the network of $ws"; fi
    local vol
    for vol in profile work home; do
      docker volume rm "deskmates-$ws-$vol" >/dev/null 2>&1 && ok "removed volume deskmates-$ws-$vol" || true
    done
  done
  rm -f "$db" "$db-wal" "$db-shm" && ok "removed $db"
  rm -f "$RUN_DIR"/*.pid
  ok "purged; the next up starts from an empty database"
}

case "$CMD" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  logs)   cmd_logs ;;
  purge)  cmd_purge ;;
  cron)    cmd_cron "${2-}" "${3-}" ;;
  webhook) cmd_webhook "${2-}" ;;
  runs)    cmd_runs ;;
  *) die "usage: $0 up|down|status|logs|purge|cron|webhook|runs" ;;
esac
