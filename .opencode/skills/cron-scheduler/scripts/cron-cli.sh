#!/usr/bin/env bash
# cron-cli: Full admin CLI for cron-scheduler skill.
# All agent commands plus: start, stop, status, install-cmd, clear.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

# --- Defaults ---
CRONICLE_URL="${CRONICLE_URL:-http://localhost:3012}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-}"
CRONICLE_PORT="${CRONICLE_PORT:-3012}"

CRONICLE_INSTALL_DIR="${CRONICLE_INSTALL_DIR:-/opt/cronicle}"

usage() {
  cat <<'EOF'
Usage: cron-cli <command> [args]

Admin:
  start                               Start Cronicle master (host-native, systemd)
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
  callback --session <id> --schedule <cron> [--name <name>] [--prompt <text>] [--host <hostname>]
                                       Create agent callback job (runs on host worker)
EOF
}

inject_secrets() {
  if command -v config-cli &>/dev/null; then
    if [[ -z "$CRONICLE_API_KEY" ]]; then
      CRONICLE_API_KEY="$(config-cli get CRONICLE_API_KEY 2>/dev/null || true)"
    fi
    if [[ "$CRONICLE_URL" == "http://localhost:3012" ]]; then
      local vault_url
      vault_url="$(config-cli get CRONICLE_URL 2>/dev/null || true)"
      if [[ -n "$vault_url" ]]; then
        CRONICLE_URL="$vault_url"
      fi
    fi
  fi
}

# --- Admin Commands ---

# Check if Cronicle is installed on host
is_installed() {
  [[ -f "${CRONICLE_INSTALL_DIR}/bin/control.sh" ]]
}

cmd_start() {
  echo "[cron-cli] Starting Cronicle master..."

  # Inject secrets from vault if available
  inject_secrets

  # Install Cronicle if not present
  if ! is_installed; then
    echo "[cron-cli] Cronicle not found at ${CRONICLE_INSTALL_DIR}. Installing..."
    local secret="${CRONICLE_SECRET:-$(openssl rand -hex 16)}"
    sudo bash "${SCRIPT_DIR}/install-worker.sh" \
      --server "http://localhost:${CRONICLE_PORT}" \
      --secret "$secret" \
      --install-dir "$CRONICLE_INSTALL_DIR"
    # Run setup to make this node the master
    sudo "${CRONICLE_INSTALL_DIR}/bin/control.sh" setup 2>/dev/null || true
    CRONICLE_SECRET="$secret"
  fi

  # Generate API key if not set
  if [[ -z "${CRONICLE_API_KEY:-}" ]]; then
    CRONICLE_API_KEY="$(openssl rand -hex 16)"
    echo "[cron-cli] Generated new API key: ${CRONICLE_API_KEY}"
  fi

  # Ensure systemd service exists and start
  if command -v systemctl &>/dev/null; then
    if ! systemctl is-active cronicle &>/dev/null; then
      sudo systemctl start cronicle
    fi
    echo "[cron-cli] Cronicle service started."
  else
    sudo "${CRONICLE_INSTALL_DIR}/bin/control.sh" start
  fi

  # Wait for master election + health (can take up to 60s on first start)
  echo "[cron-cli] Waiting for Cronicle to become master (up to 90s)..."
  local attempts=0 max_attempts=45
  while ((attempts < max_attempts)); do
    local resp
    resp=$(curl -sf "http://localhost:${CRONICLE_PORT}/api/app/get_activity?offset=0&limit=1&api_key=${CRONICLE_API_KEY}" 2>/dev/null || echo "")
    local code
    code=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',''))" 2>/dev/null || echo "")
    if [[ "$code" == "0" ]]; then
      echo "[cron-cli] Cronicle is ready at http://localhost:${CRONICLE_PORT}"
      echo "[cron-cli] Web UI: http://localhost:${CRONICLE_PORT}"

      # Write server config to vault for agent/client discovery
      if command -v config-cli &>/dev/null; then
        config-cli set CRONICLE_URL "http://localhost:${CRONICLE_PORT}" 2>/dev/null || true
        config-cli set CRONICLE_API_KEY "$CRONICLE_API_KEY" 2>/dev/null || true
        local secret
        secret=$(sudo python3 -c "import json; print(json.load(open('${CRONICLE_INSTALL_DIR}/conf/config.json'))['secret_key'])" 2>/dev/null || echo "")
        if [[ -n "$secret" ]]; then
          config-cli set CRONICLE_SECRET "$secret" 2>/dev/null || true
        fi
        echo "[cron-cli] Server config written to vault (CRONICLE_URL, CRONICLE_API_KEY, CRONICLE_SECRET)"
      fi
      return 0
    fi

    # If server responds but API key is not recognized (code "api"), try creating it
    if [[ "$code" == "" ]]; then
      local resp2
      resp2=$(curl -sf "http://localhost:${CRONICLE_PORT}/api/app/get_activity?offset=0&limit=1" 2>/dev/null || echo "")
      local code2
      code2=$(echo "$resp2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code',''))" 2>/dev/null || echo "")
      if [[ "$code2" == "session" || "$code2" == "api" ]]; then
        # Server is master, create API key
        echo "[cron-cli] Creating API key..."
        _create_api_key_if_needed
        continue
      fi
    fi
    ((attempts++))
    sleep 2
  done

  echo "[cron-cli] WARNING: Cronicle did not become ready within 90s."
  echo "[cron-cli] Check logs: sudo journalctl -u cronicle --no-pager -n 20"
  return 1
}

# Helper: create API key via admin login
_create_api_key_if_needed() {
  local login_resp session_id
  login_resp=$(curl -sf -X POST "http://localhost:${CRONICLE_PORT}/api/user/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"'"${CRONICLE_ADMIN_PASSWORD:-admin}"'"}' 2>/dev/null || echo "")
  session_id=$(echo "$login_resp" | grep -oP '"session_id":"[^"]+' | cut -d'"' -f4)
  if [[ -z "$session_id" ]]; then
    return 1
  fi
  curl -sf -X POST "http://localhost:${CRONICLE_PORT}/api/app/create_api_key/v1" \
    -H "Content-Type: application/json" \
    -d "{\"session_id\":\"${session_id}\",\"key\":\"${CRONICLE_API_KEY}\",\"title\":\"Admin API Key\",\"active\":1,\"privileges\":{\"admin\":1,\"create_events\":1,\"edit_events\":1,\"delete_events\":1,\"run_events\":1,\"abort_events\":1,\"state_update\":1}}" &>/dev/null || true
}

cmd_stop() {
  echo "[cron-cli] Stopping Cronicle..."
  if command -v systemctl &>/dev/null && systemctl is-active cronicle &>/dev/null; then
    sudo systemctl stop cronicle
  elif is_installed; then
    sudo "${CRONICLE_INSTALL_DIR}/bin/control.sh" stop
  else
    echo "[cron-cli] Cronicle is not installed."
    return 1
  fi
  echo "[cron-cli] Cronicle stopped."
}

cmd_status() {
  echo "=== Cronicle Service ==="
  if command -v systemctl &>/dev/null; then
    if systemctl is-active cronicle &>/dev/null; then
      echo "  Service: RUNNING"
      echo "  Install: ${CRONICLE_INSTALL_DIR}"
    else
      echo "  Service: STOPPED"
    fi
  elif is_installed; then
    if [[ -f "${CRONICLE_INSTALL_DIR}/logs/cronicled.pid" ]]; then
      local pid
      pid=$(cat "${CRONICLE_INSTALL_DIR}/logs/cronicled.pid" 2>/dev/null || echo "")
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "  Service: RUNNING (PID $pid)"
      else
        echo "  Service: STOPPED"
      fi
    else
      echo "  Service: STOPPED"
    fi
  else
    echo "  Service: NOT INSTALLED"
  fi
  echo ""

  inject_secrets

  echo "=== Cronicle Health ==="
  if [[ -n "$CRONICLE_API_KEY" ]]; then
    local result
    if result=$(curl -sf "${CRONICLE_URL}/api/app/get_activity?offset=0&limit=1&api_key=${CRONICLE_API_KEY}" 2>/dev/null); then
      local code
      code=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code','error'))" 2>/dev/null || echo "error")
      if [[ "$code" == "0" ]]; then
        echo "  Status: HEALTHY"
        echo "  URL: ${CRONICLE_URL}"
      else
        echo "  Status: NOT MASTER (code: $code)"
        echo "  URL: ${CRONICLE_URL}"
      fi
    else
      echo "  Status: UNREACHABLE"
      echo "  URL: ${CRONICLE_URL}"
    fi
  else
    echo "  Status: NO API KEY"
    echo "  Set CRONICLE_API_KEY or use: config-cli set CRONICLE_API_KEY <key>"
  fi
}

cmd_install_cmd() {
  local server_url="${CRONICLE_URL}" tags="general"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-url) server_url="${2:?}"; shift 2 ;;
      --tags)       tags="${2:?}"; shift 2 ;;
      *) shift ;;
    esac
  done

  inject_secrets

  echo "# On a machine with cron-client installed (preferred):"
  echo "cron-client install --server-url ${server_url} --secret \"\$(config-cli get CRONICLE_SECRET)\""
  echo ""
  echo "# Or manually with install-worker.sh:"
  echo "sudo bash ${SCRIPT_DIR}/install-worker.sh \\"
  echo "  --server ${server_url} \\"
  echo "  --secret <cronicle_secret_key> \\"
  echo "  --tags ${tags}"
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

  inject_secrets

  # Get all events and delete them
  local result
  result=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1000" \
    -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null) || {
    echo "Error: Cannot reach Cronicle" >&2
    return 1
  }

  local ids
  ids=$(echo "$result" | jq -r '.rows[]?.id // empty')
  local count=0
  for id in $ids; do
    curl -sf -X POST "${CRONICLE_URL}/api/app/delete_event/v1" \
      -H "X-API-Key: ${CRONICLE_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"id\":\"${id}\"}" &>/dev/null || true
    count=$((count + 1))
  done

  echo "Deleted ${count} jobs."
}

# --- Delegate agent commands to cron-agent.sh ---
delegate_to_agent() {
  local agent_script="${SCRIPT_DIR}/cron-agent.sh"
  if [[ ! -x "$agent_script" ]]; then
    chmod +x "$agent_script"
  fi
  export CRONICLE_URL CRONICLE_API_KEY
  exec bash "$agent_script" "$@"
}

# --- Dispatch ---
case "${1:-help}" in
  # Admin commands
  start)       shift; cmd_start "$@" ;;
  stop)        shift; cmd_stop "$@" ;;
  status)      shift; cmd_status "$@" ;;
  install-cmd) shift; cmd_install_cmd "$@" ;;
  clear)       shift; cmd_clear "$@" ;;
  # Agent commands — delegate
  create|update|delete|enable|disable|run|list|get|history|execution|active|health|callback)
    inject_secrets
    delegate_to_agent "$@"
    ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
