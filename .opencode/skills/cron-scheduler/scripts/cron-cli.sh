#!/usr/bin/env bash
# cron-cli: Full admin CLI for cron-scheduler skill.
# All agent commands plus: start, stop, status, install-cmd, clear.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

# --- Defaults ---
CRONICLE_URL="${CRONICLE_URL:-http://localhost:3012}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-}"
CRONICLE_PORT="${CRONICLE_PORT:-3012}"

usage() {
  cat <<'EOF'
Usage: cron-cli <command> [args]

Admin:
  start                               Start Cronicle server (Docker)
  stop                                Stop Cronicle server
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
  callback --session <id> --schedule <cron> [--name <name>] [--prompt <text>]
                                      Create opencode callback job
EOF
}

inject_secrets() {
  if [[ -z "$CRONICLE_API_KEY" ]] && command -v config-cli &>/dev/null; then
    CRONICLE_API_KEY="$(config-cli get CRONICLE_API_KEY 2>/dev/null || true)"
  fi
}

# --- Docker Compose file detection ---
detect_compose_file() {
  if [[ -f "${OPENDAWG_ROOT}/docker-compose.yml" ]]; then
    echo "${OPENDAWG_ROOT}/docker-compose.yml"
  else
    echo "${SKILL_DIR}/docker/docker-compose.yml"
  fi
}

# --- Admin Commands ---

cmd_start() {
  local compose_file
  compose_file=$(detect_compose_file)

  echo "[cron-cli] Starting Cronicle..."

  # Inject secrets from vault if available
  if command -v config-cli &>/dev/null; then
    local vault_output
    vault_output="$(config-cli get-all 2>/dev/null || echo "")"
    if [[ -n "$vault_output" ]]; then
      eval "$vault_output"
      echo "[cron-cli] Injected secrets from vault"
    fi
  fi

  # Generate API key if not set
  if [[ -z "${CRONICLE_API_KEY:-}" ]]; then
    CRONICLE_API_KEY="$(openssl rand -hex 16)"
    echo "[cron-cli] Generated API key: ${CRONICLE_API_KEY}"
    echo "[cron-cli] Store it: config-cli set CRONICLE_API_KEY ${CRONICLE_API_KEY}"
  fi

  export CRONICLE_API_KEY CRONICLE_PORT CRONICLE_URL

  if [[ "$compose_file" == "${OPENDAWG_ROOT}/docker-compose.yml" ]]; then
    docker compose -f "$compose_file" --profile cron up -d
  else
    docker compose -f "$compose_file" up -d
  fi

  # Wait for health
  echo "[cron-cli] Waiting for Cronicle to be ready..."
  local attempts=0 max_attempts=30
  while ((attempts < max_attempts)); do
    if curl -sf "http://localhost:${CRONICLE_PORT}/api/app/get_schedule/v1?limit=1" \
       -H "X-API-Key: ${CRONICLE_API_KEY}" &>/dev/null; then
      echo "[cron-cli] Cronicle is ready at http://localhost:${CRONICLE_PORT}"
      echo "[cron-cli] Web UI: http://localhost:${CRONICLE_PORT}"
      echo "[cron-cli] API Key: ${CRONICLE_API_KEY}"
      return 0
    fi
    ((attempts++))
    sleep 2
  done

  echo "[cron-cli] WARNING: Cronicle did not become healthy within 60s."
  echo "[cron-cli] Check logs: docker compose -f ${compose_file} logs cronicle"
  return 1
}

cmd_stop() {
  local compose_file
  compose_file=$(detect_compose_file)

  echo "[cron-cli] Stopping Cronicle..."
  if [[ "$compose_file" == "${OPENDAWG_ROOT}/docker-compose.yml" ]]; then
    docker compose -f "$compose_file" --profile cron down
  else
    docker compose -f "$compose_file" down
  fi
  echo "[cron-cli] Cronicle stopped."
}

cmd_status() {
  local compose_file
  compose_file=$(detect_compose_file)

  echo "=== Docker Services ==="
  if [[ "$compose_file" == "${OPENDAWG_ROOT}/docker-compose.yml" ]]; then
    docker compose -f "$compose_file" --profile cron ps 2>/dev/null || echo "  (not running)"
  else
    docker compose -f "$compose_file" ps 2>/dev/null || echo "  (not running)"
  fi
  echo ""

  inject_secrets

  echo "=== Cronicle Health ==="
  if [[ -n "$CRONICLE_API_KEY" ]]; then
    local result
    if result=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
       -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null); then
      echo "  Status: HEALTHY"
      echo "  URL: ${CRONICLE_URL}"
      local job_count
      job_count=$(echo "$result" | jq -r '.list.length // 0')
      echo "  Jobs: ${job_count}"
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

  echo "# Run this on the worker machine to install Cronicle worker:"
  echo "curl -sL ${server_url}/install-worker.sh | bash -s -- \\"
  echo "  --server ${server_url} \\"
  echo "  --secret \"\$(config-cli get CRONICLE_SECRET)\" \\"
  echo "  --tags ${tags}"
  echo ""
  echo "# Or manually:"
  echo "bash ${SKILL_DIR}/scripts/install-worker.sh \\"
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
