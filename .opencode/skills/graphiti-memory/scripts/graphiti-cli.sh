#!/usr/bin/env bash
# graphiti-cli: Full admin/management script for Graphiti knowledge graph.
# Supports ALL operations including destructive ones (clear, delete).
# For agent use, see graphiti-agent.sh (safe subset).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ENDPOINT="http://localhost:8000/mcp"
HEALTH_ENDPOINT="http://localhost:8000/health"
GROUP_ID="${GRAPHITI_GROUP_ID:-opendawg}"

OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

# Docker compose: prefer root docker-compose.yml (with profiles), fallback to skill-local one
if [[ -f "${OPENDAWG_ROOT}/docker-compose.yml" ]]; then
  DOCKER_COMPOSE_FILE="${OPENDAWG_ROOT}/docker-compose.yml"
  DOCKER_COMPOSE_PROFILE="--profile graphiti"
else
  DOCKER_COMPOSE_FILE="${SCRIPT_DIR}/../docker/docker-compose.yml"
  DOCKER_COMPOSE_PROFILE=""
fi

usage() {
  cat <<'EOF'
Usage: graphiti-cli <command> [args]

Service Management:
  start                       Start Neo4j + Graphiti (injects secrets via config-cli)
  stop                        Stop all services
  status                      Show service status and health

Memory Operations:
  remember <text> [flags]     Store a new episode
  search <query>              Search facts in the knowledge graph
  search-nodes <query>        Search entity nodes
  episodes [--last N]         List recent episodes (default: 10)
  get-edge <uuid>             Get an entity edge by UUID

Delete Operations:
  delete-episode <uuid>       Delete a single episode by UUID
  delete-edge <uuid>          Delete a single entity edge by UUID
  clear [--confirm]           ⚠️  Clear ALL data for the current group

Flags for 'remember':
  --source <source>           Source label (e.g., user-instruction, observation)
  --metadata key=value        Additional metadata (repeatable)
  --name <name>               Episode name (default: auto-generated)

Environment:
  GRAPHITI_GROUP_ID           Group ID for partitioning (default: opendawg)
EOF
}

check_prereq() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '${cmd}' is required but not found." >&2
    return 1
  fi
}

wait_for_health() {
  local max_attempts=30
  local attempt=0
  echo "Waiting for Graphiti to become healthy..."
  while [[ $attempt -lt $max_attempts ]]; do
    if curl -sf "$HEALTH_ENDPOINT" &>/dev/null; then
      echo "Graphiti is healthy."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  echo "Error: Graphiti did not become healthy within 60s." >&2
  return 1
}

# --- Service Management ---

cmd_start() {
  check_prereq docker
  check_prereq config-cli
  echo "Starting Graphiti services..."
  local vault_output
  vault_output="$(config-cli get-all 2>/dev/null || echo "")"
  if [[ -n "$vault_output" ]]; then
    eval "$vault_output"
  fi
  # shellcheck disable=SC2086
  docker compose -f "${DOCKER_COMPOSE_FILE}" ${DOCKER_COMPOSE_PROFILE} up -d
  wait_for_health
  echo "Services are running. MCP endpoint: ${MCP_ENDPOINT}"
}

cmd_stop() {
  check_prereq docker
  echo "Stopping Graphiti services..."
  # shellcheck disable=SC2086
  docker compose -f "${DOCKER_COMPOSE_FILE}" ${DOCKER_COMPOSE_PROFILE} down
  echo "Services stopped."
}

cmd_status() {
  check_prereq docker
  echo "=== Docker Services ==="
  # shellcheck disable=SC2086
  docker compose -f "${DOCKER_COMPOSE_FILE}" ${DOCKER_COMPOSE_PROFILE} ps 2>/dev/null || echo "(not running)"
  echo ""
  echo "=== Health Check ==="
  if curl -sf "$HEALTH_ENDPOINT" 2>/dev/null; then
    echo ""
    echo "Graphiti: healthy"
  else
    echo "Graphiti: not reachable"
  fi
  echo ""
  echo "=== MCP Status ==="
  mcp call get_status --params '{}' "$MCP_ENDPOINT" 2>/dev/null || echo "(could not reach MCP)"
}

# --- Memory Operations ---

cmd_search() {
  local query="${1:?Error: Query required. Usage: graphiti-cli search <query>}"
  check_prereq mcp
  check_prereq jq
  local query_escaped
  query_escaped="$(printf '%s' "$query" | jq -Rs .)"
  mcp call search_memory_facts --params "{\"query\":${query_escaped},\"group_ids\":[\"${GROUP_ID}\"]}" \
    "$MCP_ENDPOINT"
}

cmd_search_nodes() {
  local query="${1:?Error: Query required. Usage: graphiti-cli search-nodes <query>}"
  check_prereq mcp
  check_prereq jq
  local query_escaped
  query_escaped="$(printf '%s' "$query" | jq -Rs .)"
  mcp call search_nodes --params "{\"query\":${query_escaped},\"group_ids\":[\"${GROUP_ID}\"]}" \
    "$MCP_ENDPOINT"
}

cmd_remember() {
  if [[ $# -lt 1 ]]; then
    echo "Error: Text required. Usage: graphiti-cli remember <text> [flags]" >&2
    exit 1
  fi
  check_prereq mcp

  local text=""
  local source="cli"
  local episode_name=""
  local -a metadata_pairs=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)   source="${2:?Error: --source requires a value}"; shift 2 ;;
      --metadata) metadata_pairs+=("${2:?Error: --metadata requires key=value}"); shift 2 ;;
      --name)     episode_name="${2:?Error: --name requires a value}"; shift 2 ;;
      *)
        if [[ -z "$text" ]]; then text="$1"; else text="${text} $1"; fi
        shift ;;
    esac
  done

  if [[ -z "$text" ]]; then
    echo "Error: No text provided." >&2
    exit 1
  fi

  local timestamp hostname_val cwd_val project_val
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  hostname_val="$(hostname)"
  cwd_val="$(pwd)"
  project_val="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$cwd_val")")"

  if [[ -z "$episode_name" ]]; then
    episode_name="episode-$(date +%s)"
  fi

  local body="${text}

---
source: ${source}
timestamp: ${timestamp}
hostname: ${hostname_val}
cwd: ${cwd_val}
project: ${project_val}"

  for pair in "${metadata_pairs[@]+"${metadata_pairs[@]}"}"; do
    body="${body}
${pair}"
  done

  local body_escaped name_escaped
  body_escaped="$(printf '%s' "$body" | jq -Rs .)"
  name_escaped="$(printf '%s' "$episode_name" | sed 's/"/\\"/g')"

  mcp call add_memory --params "{\"name\":\"${name_escaped}\",\"episode_body\":${body_escaped},\"group_id\":\"${GROUP_ID}\",\"source\":\"text\",\"source_description\":\"${source}\"}" \
    "$MCP_ENDPOINT"
}

cmd_episodes() {
  check_prereq mcp
  local last_n=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --last) last_n="${2:?Error: --last requires a number}"; shift 2 ;;
      *) echo "Error: Unknown flag '${1}'" >&2; exit 1 ;;
    esac
  done
  mcp call get_episodes --params "{\"group_ids\":[\"${GROUP_ID}\"],\"max_episodes\":${last_n}}" \
    "$MCP_ENDPOINT"
}

cmd_get_edge() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-cli get-edge <uuid>}"
  check_prereq mcp
  mcp call get_entity_edge --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

# --- Delete Operations ---

cmd_delete_episode() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-cli delete-episode <uuid>}"
  check_prereq mcp
  mcp call delete_episode --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

cmd_delete_edge() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-cli delete-edge <uuid>}"
  check_prereq mcp
  mcp call delete_entity_edge --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

cmd_clear() {
  local confirmed=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --confirm) confirmed=true; shift ;;
      *) echo "Error: Unknown flag '${1}'" >&2; exit 1 ;;
    esac
  done

  if [[ "$confirmed" != true ]]; then
    echo "⚠️  This will DELETE ALL data for group '${GROUP_ID}'."
    echo "Run with --confirm to proceed:"
    echo "  graphiti-cli clear --confirm"
    exit 1
  fi

  check_prereq mcp
  echo "Clearing all data for group '${GROUP_ID}'..."
  mcp call clear_graph --params "{\"group_ids\":[\"${GROUP_ID}\"]}" "$MCP_ENDPOINT"
  echo "Done."
}

# --- Dispatch ---
case "${1:-help}" in
  start)          shift; cmd_start ;;
  stop)           shift; cmd_stop ;;
  status)         shift; cmd_status ;;
  search)         shift; cmd_search "$@" ;;
  search-nodes)   shift; cmd_search_nodes "$@" ;;
  remember)       shift; cmd_remember "$@" ;;
  episodes)       shift; cmd_episodes "$@" ;;
  get-edge)       shift; cmd_get_edge "$@" ;;
  delete-episode) shift; cmd_delete_episode "$@" ;;
  delete-edge)    shift; cmd_delete_edge "$@" ;;
  clear)          shift; cmd_clear "$@" ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
