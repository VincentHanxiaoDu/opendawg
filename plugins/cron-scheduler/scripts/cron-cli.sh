#!/usr/bin/env bash
# cron-cli: Full admin CLI for cron-scheduler plugin.
# All agent commands plus: start, stop, status, install-cmd, clear.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_cron-lib.sh
source "${SCRIPT_DIR}/_cron-lib.sh"

CRONICLE_ADMIN_PASSWORD="${CRONICLE_ADMIN_PASSWORD:-admin}"
CRONICLE_VERSION="${CRONICLE_VERSION:-master}"

usage() {
  cat <<'EOF'
Usage: cron-cli <command> [args]

Admin:
  start                               Start Cronicle master (native, project-local)
  stop                                Stop Cronicle master
  status                              Show server and service status
  install-cmd [--server-url <url>] [--tags <tags>]
                                      Generate worker install command
  clear --confirm                     Delete ALL jobs and history

Job Management (same as cron-agent):
  create <jobspec-json>               Create a job
  update <id> <jobspec-json>          Update a job
  delete <id>                         Delete a job
  enable <id>                         Enable a job
  disable <id>                        Disable a job
  run <id>                            Run a job immediately
  list [--limit N]                    List all jobs
  get <id-or-title>                   Get job details

Execution History:
  history <id> [--limit N]            Execution history for a job
  execution <id>                      Get execution details
  active                              List running jobs

System:
  health                              Server health check

Convenience:
  callback --session <id> --schedule <expr> [options]
                                      Create agent callback job
EOF
}

# ============================================================
# Admin Commands
# ============================================================

is_cronicle_installed() {
  [[ -f "${CRONICLE_HOME}/bin/control.sh" ]]
}

is_cronicle_running() {
  local pidfile="${CRONICLE_HOME}/logs/cronicled.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && return 0
  fi
  return 1
}

cmd_start() {
  echo "[cron-cli] Starting Cronicle master..."

  load_config

  # Check if already running
  if is_cronicle_running; then
    echo "[cron-cli] Cronicle is already running."
    return 0
  fi

  # Check Node.js
  if ! command -v node &>/dev/null; then
    die "Node.js is required. Install Node.js 18+ first."
  fi

  # Install Cronicle if not present
  if ! is_cronicle_installed; then
    echo "[cron-cli] Installing Cronicle to ${CRONICLE_HOME}..."
    mkdir -p "$CRONICLE_HOME"

    echo "[cron-cli] Downloading Cronicle..."
    curl -sL "https://github.com/jhuckaby/Cronicle/archive/${CRONICLE_VERSION}.tar.gz" | \
      tar xz --strip-components=1 -C "$CRONICLE_HOME"

    echo "[cron-cli] Installing dependencies (npm install --production)..."
    (cd "$CRONICLE_HOME" && npm install --production 2>&1 | tail -1)

    echo "[cron-cli] Building Cronicle..."
    (cd "$CRONICLE_HOME" && node bin/build.js dist 2>&1 | tail -1)

    echo "[cron-cli] Cronicle installed."
  fi

  # Generate secret_key if not in vault
  local secret_key
  secret_key="$(vault_get CRONICLE_SECRET)"
  if [[ -z "$secret_key" ]]; then
    secret_key="$(openssl rand -hex 16)"
    echo "[cron-cli] Generated new secret_key."
  fi

  # Patch conf/config.json
  local config_file="${CRONICLE_HOME}/conf/config.json"
  if [[ -f "$config_file" ]]; then
    local tmp_config
    tmp_config=$(jq \
      --arg port "$CRONICLE_PORT" \
      --arg secret "$secret_key" \
      --arg base_url "http://localhost:${CRONICLE_PORT}" \
      '.WebServer.http_port = ($port | tonumber) |
       .secret_key = $secret |
       .base_app_url = $base_url' \
      "$config_file")
    echo "$tmp_config" > "$config_file"
    echo "[cron-cli] Patched config.json (port=${CRONICLE_PORT})."
  fi

  # Run setup if first time (no data/ directory)
  if [[ ! -d "${CRONICLE_HOME}/data" ]]; then
    echo "[cron-cli] Running first-time setup..."
    (cd "$CRONICLE_HOME" && node bin/storage-cli.js setup 2>&1 | tail -3)
  fi

  # Generate API key
  if [[ -z "$CRONICLE_API_KEY" ]]; then
    CRONICLE_API_KEY="$(openssl rand -hex 16)"
    echo "[cron-cli] Generated new API key."
  fi

  # Start Cronicle
  echo "[cron-cli] Starting Cronicle process..."
  (cd "$CRONICLE_HOME" && bash bin/control.sh start 2>&1)

  # Poll until ready (max 60 attempts, 1s each — Cronicle needs up to 60s for master election)
  echo "[cron-cli] Waiting for Cronicle to become ready (up to 60s)..."
  local attempts=0 max_attempts=60
  local api_key_created=false
  while ((attempts < max_attempts)); do
    # Check if server is responding at all
    local resp
    resp=$(curl -s --max-time 2 "http://localhost:${CRONICLE_PORT}/api/app/get_schedule/v1?limit=1" \
      -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo "")

    if [[ -n "$resp" ]]; then
      local code
      code=$(echo "$resp" | jq -r '.code // ""' 2>/dev/null || echo "")

      if [[ "$code" == "0" ]]; then
        echo "[cron-cli] Cronicle is ready at http://localhost:${CRONICLE_PORT}"

        # Write config to vault
        if command -v config-cli &>/dev/null; then
          vault_set CRONICLE_URL "http://localhost:${CRONICLE_PORT}"
          vault_set CRONICLE_API_KEY "$CRONICLE_API_KEY"
          vault_set CRONICLE_SECRET "$secret_key"
          echo "[cron-cli] Server config written to vault."
        fi
        return 0
      fi

      # Server responding but API key not recognized — create it via HTTP login
      if [[ "$api_key_created" != true ]]; then
        if _try_create_api_key_http; then
          api_key_created=true
          echo "[cron-cli] API key created via HTTP."
        fi
      fi
    fi

    ((attempts++))
    sleep 1
  done

  echo "[cron-cli] WARNING: Cronicle did not become ready within ${max_attempts}s."
  echo "[cron-cli] Check logs: ${CRONICLE_HOME}/logs/"
  return 1
}

_try_create_api_key_http() {
  # Cronicle's login response contains escape sequences that break jq, so use grep
  local login_resp session_id
  login_resp=$(curl -s --max-time 5 -X POST "http://localhost:${CRONICLE_PORT}/api/user/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"${CRONICLE_ADMIN_PASSWORD}\"}" 2>/dev/null || echo "")
  session_id=$(echo "$login_resp" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"//')
  if [[ -z "$session_id" ]]; then return 1; fi
  local create_resp
  create_resp=$(curl -s --max-time 5 -X POST "http://localhost:${CRONICLE_PORT}/api/app/create_api_key/v1" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"${session_id}\",\"key\":\"${CRONICLE_API_KEY}\",\"title\":\"opendawg\",\"active\":1,\"privileges\":{\"admin\":1,\"create_events\":1,\"edit_events\":1,\"delete_events\":1,\"run_events\":1,\"abort_events\":1,\"state_update\":1}}" 2>/dev/null || echo "")
  echo "$create_resp" | grep -q '"code":0' && return 0
  # Key might already exist — that's OK
  echo "$create_resp" | grep -q '"key already in use"' && return 0
  return 1
}

cmd_stop() {
  echo "[cron-cli] Stopping Cronicle..."
  if ! is_cronicle_installed; then
    echo "[cron-cli] Cronicle is not installed."
    return 1
  fi
  if ! is_cronicle_running; then
    echo "[cron-cli] Cronicle is not running."
    return 0
  fi
  (cd "$CRONICLE_HOME" && bash bin/control.sh stop 2>&1)
  echo "[cron-cli] Cronicle stopped."
}

cmd_status() {
  load_config

  echo "=== Cronicle Service ==="
  echo "  Install: ${CRONICLE_HOME}"
  if ! is_cronicle_installed; then
    echo "  Status: NOT INSTALLED"
    return
  fi

  if is_cronicle_running; then
    local pid
    pid=$(cat "${CRONICLE_HOME}/logs/cronicled.pid" 2>/dev/null || echo "?")
    echo "  Status: RUNNING (PID ${pid})"
  else
    echo "  Status: STOPPED"
  fi
  echo ""

  echo "=== Cronicle Health ==="
  if [[ -n "${CRONICLE_API_KEY:-}" ]]; then
    local result
    if result=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
      -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null); then
      local code
      code=$(echo "$result" | jq -r '.code // "error"' 2>/dev/null || echo "error")
      if [[ "$code" == "0" ]]; then
        echo "  Health: HEALTHY"
        local job_count
        job_count=$(echo "$result" | jq -r '.list.length // 0')
        echo "  Jobs: ${job_count}"
      else
        echo "  Health: UNHEALTHY (code: $code)"
      fi
    else
      echo "  Health: UNREACHABLE"
    fi
    echo "  URL: ${CRONICLE_URL}"
  else
    echo "  Health: NO API KEY"
    echo "  Run 'cron-cli start' to auto-generate keys."
  fi
}

cmd_install_cmd() {
  load_config
  local server_url="${CRONICLE_URL}" tags="general"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-url) server_url="${2:?}"; shift 2 ;;
      --tags)       tags="${2:?}"; shift 2 ;;
      *) shift ;;
    esac
  done

  echo "# Install worker via cron-client (preferred):"
  echo "cron-client install --server-url ${server_url} --secret \"\$(config-cli get CRONICLE_SECRET)\""
  echo ""
  echo "# Worker tags: ${tags}"
}

cmd_clear() {
  local confirmed=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --confirm) confirmed=true; shift ;;
      *) shift ;;
    esac
  done

  if [[ "$confirmed" != true ]]; then
    echo "Error: This will delete ALL jobs. Pass --confirm to proceed." >&2
    return 1
  fi

  load_config
  require_api_key

  local count=0 offset=0 page_size=100
  while true; do
    local result
    result=$(cronicle_api GET "/api/app/get_schedule/v1?offset=${offset}&limit=${page_size}") || {
      echo "Error: Cannot reach Cronicle" >&2; return 1
    }

    local ids
    ids=$(echo "$result" | jq -r '.rows[]?.id // empty')
    [[ -z "$ids" ]] && break

    for id in $ids; do
      cronicle_api POST "/api/app/delete_event/v1" "{\"id\":\"${id}\"}" >/dev/null || true
      count=$((count + 1))
    done

    local returned
    returned=$(echo "$result" | jq -r '.rows | length')
    (( returned < page_size )) && break
    offset=$((offset + page_size))
  done

  echo "Deleted ${count} jobs."
}

# ============================================================
# Dispatch
# ============================================================

case "${1:-help}" in
  # Admin commands
  start)       shift; cmd_start "$@" ;;
  stop)        shift; cmd_stop "$@" ;;
  status)      shift; cmd_status "$@" ;;
  install-cmd) shift; cmd_install_cmd "$@" ;;
  clear)       shift; cmd_clear "$@" ;;
  # Agent commands — load config first
  create|update|delete|enable|disable|run|list|get|history|execution|active|callback)
    load_config
    require_api_key
    cmd="${1}"; shift
    "cmd_${cmd}" "$@"
    ;;
  health)
    load_config
    require_api_key
    shift; cmd_health "$@"
    ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
