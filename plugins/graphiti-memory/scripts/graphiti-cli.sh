#!/usr/bin/env bash
# graphiti-cli: Full admin CLI for graphiti-memory plugin.
# All agent commands plus: start, stop, status, clear.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=_graphiti-lib.sh
source "${SCRIPT_DIR}/_graphiti-lib.sh"

usage() {
  cat <<'EOF'
Usage: graphiti-cli <command> [args]

Admin:
  start                               Start Neo4j + Graphiti (Docker)
  stop                                Stop all services
  status                              Show service status and health
  clear --confirm                     Clear ALL data for current group_id

Memory Operations (same as graphiti-agent):
  search <query>                      Search facts (semantic)
  search-nodes <query>                Search entity nodes
  remember <text> [flags]             Store a new episode
  episodes [--last N]                 List recent episodes (default: 10)
  get-edge <uuid>                     Get an entity edge by UUID
  delete-episode <uuid>               Delete one episode
  delete-edge <uuid>                  Delete one entity edge

System:
  health                              Service health check
EOF
}

# ============================================================
# Admin Commands
# ============================================================

cmd_start() {
  echo "[graphiti-cli] Starting Graphiti services..."

  load_config

  # Load secrets from vault and export for docker compose
  # Vault keys are lowercase (matching plugin.yaml config schema)
  if command -v config-cli &>/dev/null; then
    local val

    # Try UPPER then lower for each key (env vars override vault)
    val="$(vault_get AZURE_OPENAI_API_KEY)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_api_key)"
    [[ -n "$val" ]] && export AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY:-$val}"

    val="$(vault_get AZURE_OPENAI_ENDPOINT)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_endpoint)"
    [[ -n "$val" ]] && export AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT:-$val}"

    val="$(vault_get AZURE_OPENAI_DEPLOYMENT)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_deployment)"
    [[ -n "$val" ]] && export AZURE_OPENAI_DEPLOYMENT="${AZURE_OPENAI_DEPLOYMENT:-${val}}"

    val="$(vault_get AZURE_OPENAI_API_VERSION)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_api_version)"
    [[ -n "$val" ]] && export AZURE_OPENAI_API_VERSION="${AZURE_OPENAI_API_VERSION:-${val}}"

    val="$(vault_get AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_embeddings_deployment)"
    [[ -n "$val" ]] && export AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT="${AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT:-${val}}"

    val="$(vault_get AZURE_OPENAI_EMBEDDINGS_ENDPOINT)"; [[ -z "$val" ]] && val="$(vault_get azure_openai_embeddings_endpoint)"
    [[ -n "$val" ]] && export AZURE_OPENAI_EMBEDDINGS_ENDPOINT="${AZURE_OPENAI_EMBEDDINGS_ENDPOINT:-${val}}"

    val="$(vault_get NEO4J_PASSWORD)"; [[ -z "$val" ]] && val="$(vault_get neo4j_password)"
    [[ -n "$val" ]] && export NEO4J_PASSWORD="${NEO4J_PASSWORD:-$val}"
  fi

  # Validate required secrets
  [[ -n "${AZURE_OPENAI_API_KEY:-}" ]] || die "AZURE_OPENAI_API_KEY not set. Run: config-cli set AZURE_OPENAI_API_KEY <key>"
  [[ -n "${AZURE_OPENAI_ENDPOINT:-}" ]] || die "AZURE_OPENAI_ENDPOINT not set. Run: config-cli set AZURE_OPENAI_ENDPOINT <url>"

  # Export port and group_id for docker compose
  export GRAPHITI_PORT
  export GRAPHITI_GROUP_ID

  # Default embeddings endpoint to main endpoint if not set
  export AZURE_OPENAI_EMBEDDINGS_ENDPOINT="${AZURE_OPENAI_EMBEDDINGS_ENDPOINT:-${AZURE_OPENAI_ENDPOINT}}"

  echo "[graphiti-cli] Starting Docker services..."
  eval "$(compose_cmd) up -d"

  # Poll health endpoint (max 120s — Neo4j needs ~30s startup)
  echo "[graphiti-cli] Waiting for Graphiti to become healthy (up to 120s)..."
  local attempts=0 max_attempts=120
  while ((attempts < max_attempts)); do
    if curl -sf --max-time 2 "${GRAPHITI_URL}/health" >/dev/null 2>&1; then
      echo "[graphiti-cli] Graphiti is ready."
      echo ""
      echo "  MCP endpoint: ${MCP_ENDPOINT}"
      echo "  Group ID:     ${GRAPHITI_GROUP_ID}"
      echo "  Neo4j:        http://localhost:${NEO4J_HTTP_PORT:-7474}"
      echo ""

      # Persist URL to vault
      if command -v config-cli &>/dev/null; then
        vault_set GRAPHITI_URL "$GRAPHITI_URL"
        vault_set GRAPHITI_GROUP_ID "$GRAPHITI_GROUP_ID"
      fi
      return 0
    fi

    ((attempts++))
    sleep 1
  done

  echo "[graphiti-cli] WARNING: Graphiti did not become healthy within ${max_attempts}s."
  echo "[graphiti-cli] Check logs: $(compose_cmd) logs"
  return 1
}

cmd_stop() {
  echo "[graphiti-cli] Stopping Graphiti services..."
  load_config
  eval "$(compose_cmd) down"
  echo "[graphiti-cli] Services stopped."
}

cmd_status() {
  load_config

  echo "=== Graphiti Services ==="
  eval "$(compose_cmd) ps" 2>/dev/null || echo "  Docker services: NOT RUNNING"
  echo ""

  echo "=== Health ==="
  if curl -sf --max-time 5 "${GRAPHITI_URL}/health" >/dev/null 2>&1; then
    echo "  Health: HEALTHY"
  else
    echo "  Health: UNREACHABLE"
  fi
  echo "  URL:      ${GRAPHITI_URL}"
  echo "  MCP:      ${MCP_ENDPOINT}"
  echo "  Group ID: ${GRAPHITI_GROUP_ID}"
}

cmd_clear() {
  load_config

  local confirmed=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --confirm) confirmed=true; shift ;;
      *) shift ;;
    esac
  done

  if [[ "$confirmed" != true ]]; then
    echo "Error: This will clear ALL data for group '${GRAPHITI_GROUP_ID}'. Pass --confirm to proceed." >&2
    return 1
  fi

  local params
  params=$(jq -n --arg gid "$GRAPHITI_GROUP_ID" '{group_ids: [$gid]}')
  mcp_call "clear_graph" "$params" >/dev/null || return 1
  echo "Cleared graph data for group: ${GRAPHITI_GROUP_ID}"
}

# ============================================================
# Dispatch
# ============================================================

case "${1:-help}" in
  # Admin commands
  start)  shift; cmd_start "$@" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  clear)  shift; cmd_clear "$@" ;;
  # Agent commands — load config first
  search|search-nodes|remember|episodes|get-edge|delete-episode|delete-edge)
    load_config
    cmd="${1}"; shift
    # Convert hyphenated command to function name
    func="cmd_${cmd//-/_}"
    "$func" "$@"
    ;;
  health)
    load_config
    shift; cmd_health "$@"
    ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
