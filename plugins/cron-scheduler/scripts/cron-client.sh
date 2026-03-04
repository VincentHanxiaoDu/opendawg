#!/usr/bin/env bash
# cron-client: Host-side Cronicle worker lifecycle management.
# Installs, monitors, and removes a Cronicle worker on the local machine.
# The worker connects to the Cronicle master and executes jobs locally.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_cron-lib.sh
source "${SCRIPT_DIR}/_cron-lib.sh"

WORKER_HOME="${OPENDAWG_ROOT}/.opendawg/cronicle-worker"
CRONICLE_VERSION="${CRONICLE_VERSION:-master}"

usage() {
  cat <<'EOF'
Usage: cron-client <command> [options]

Commands:
  install [--server-url <url>] [--secret <key>]
                                Install and register Cronicle worker on this host
  status                        Show worker status and connection info
  uninstall [--purge]           Stop and remove the worker

The worker connects to the Cronicle master and executes scheduled tasks
locally with full access to the host environment.

Server config is auto-discovered from config-cli vault if available.
EOF
}

# ============================================================
# Helpers
# ============================================================

is_worker_installed() {
  [[ -f "${WORKER_HOME}/bin/control.sh" ]]
}

is_worker_running() {
  local pidfile="${WORKER_HOME}/logs/cronicled.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && return 0
  fi
  return 1
}

# ============================================================
# Commands
# ============================================================

cmd_install() {
  local server_url="${CRONICLE_URL:-}"
  local secret="${CRONICLE_SECRET:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --server-url) server_url="${2:?Error: --server-url requires URL}"; shift 2 ;;
      --secret)     secret="${2:?Error: --secret requires value}"; shift 2 ;;
      *) die "Unknown option '$1'" ;;
    esac
  done

  # Try vault if not provided via flags
  load_config
  server_url="${server_url:-${CRONICLE_URL:-}}"
  if [[ -z "$secret" ]]; then
    secret="$(vault_get CRONICLE_SECRET)"
  fi

  [[ -n "$server_url" ]] || die "Server URL required. Provide --server-url or set CRONICLE_URL in vault."
  [[ -n "$secret" ]]     || die "Server secret required. Provide --secret or set CRONICLE_SECRET in vault."

  # Check if already running
  if is_worker_running; then
    echo "[cron-client] Worker is already running. Use 'cron-client uninstall' first to reinstall."
    return 0
  fi

  # Check Node.js
  if ! command -v node &>/dev/null; then
    die "Node.js is required. Install Node.js 18+ first."
  fi

  echo "[cron-client] Installing Cronicle worker on $(hostname)..."
  echo "[cron-client] Server: ${server_url}"

  # Install Cronicle if not present
  if ! is_worker_installed; then
    mkdir -p "$WORKER_HOME"

    echo "[cron-client] Downloading Cronicle..."
    curl -sL "https://github.com/jhuckaby/Cronicle/archive/${CRONICLE_VERSION}.tar.gz" | \
      tar xz --strip-components=1 -C "$WORKER_HOME"

    echo "[cron-client] Installing dependencies..."
    (cd "$WORKER_HOME" && npm install --production 2>&1 | tail -1)

    echo "[cron-client] Building Cronicle..."
    (cd "$WORKER_HOME" && node bin/build.js dist 2>&1 | tail -1)
  fi

  # Configure as worker (not master)
  local config_file="${WORKER_HOME}/conf/config.json"
  if [[ -f "$config_file" ]]; then
    local port=$((CRONICLE_PORT + 1))
    local tmp_config
    tmp_config=$(jq \
      --arg secret "$secret" \
      --arg base_url "$server_url" \
      --argjson port "$port" \
      '.secret_key = $secret |
       .base_app_url = $base_url |
       .WebServer.http_port = $port |
       .server_comm_use_hostnames = false |
       .web_direct_connect = false' \
      "$config_file")
    echo "$tmp_config" > "$config_file"
  fi

  # Run setup if first time
  if [[ ! -d "${WORKER_HOME}/data" ]]; then
    echo "[cron-client] Running first-time setup..."
    (cd "$WORKER_HOME" && node bin/storage-cli.js setup 2>&1 | tail -3)
  fi

  # Start worker
  echo "[cron-client] Starting worker..."
  (cd "$WORKER_HOME" && bash bin/control.sh start 2>&1)

  # Wait for PID file
  local attempts=0
  while ((attempts < 10)); do
    if is_worker_running; then
      echo ""
      echo "[cron-client] Worker installed and running on $(hostname)."
      echo "[cron-client] Install dir: ${WORKER_HOME}"
      echo "[cron-client] Server: ${server_url}"
      return 0
    fi
    ((attempts++))
    sleep 1
  done

  echo "[cron-client] Warning: Worker may not have started. Check ${WORKER_HOME}/logs/"
  return 1
}

cmd_status() {
  load_config

  echo "=== Cron Client (Worker) ==="
  echo "  Hostname:    $(hostname)"
  echo "  Install dir: ${WORKER_HOME}"

  if ! is_worker_installed; then
    echo "  Status: NOT INSTALLED"
    return
  fi

  if is_worker_running; then
    local pid
    pid=$(cat "${WORKER_HOME}/logs/cronicled.pid" 2>/dev/null || echo "?")
    echo "  Status: RUNNING (PID ${pid})"
  else
    echo "  Status: STOPPED"
  fi

  # Show configured server URL
  local config_file="${WORKER_HOME}/conf/config.json"
  if [[ -f "$config_file" ]]; then
    local server
    server=$(jq -r '.base_app_url // "unknown"' "$config_file" 2>/dev/null || echo "unknown")
    echo "  Server: ${server}"
  fi

  # Check if master is reachable
  if [[ -n "${CRONICLE_API_KEY:-}" ]]; then
    local server="${CRONICLE_URL:-http://localhost:3012}"
    if curl -sf "${server}/api/app/get_schedule/v1?limit=0" \
       -H "X-API-Key: ${CRONICLE_API_KEY}" &>/dev/null; then
      echo "  Master reachable: YES"
    else
      echo "  Master reachable: NO"
    fi
  fi
}

cmd_uninstall() {
  local purge=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --purge) purge=true; shift ;;
      *) shift ;;
    esac
  done

  echo "[cron-client] Uninstalling worker from $(hostname)..."

  if is_worker_running; then
    echo "[cron-client] Stopping worker..."
    (cd "$WORKER_HOME" && bash bin/control.sh stop 2>&1) || true
  fi

  if [[ "$purge" == true ]]; then
    if [[ -d "$WORKER_HOME" ]]; then
      rm -rf "$WORKER_HOME"
      echo "[cron-client] Removed ${WORKER_HOME}"
    fi
  else
    echo "[cron-client] Worker stopped. Use --purge to also remove ${WORKER_HOME}"
  fi

  echo "[cron-client] Worker uninstalled."
}

# ============================================================
# Dispatch
# ============================================================

case "${1:-help}" in
  install)   shift; cmd_install "$@" ;;
  status)    shift; cmd_status "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
