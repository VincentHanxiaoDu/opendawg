#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="${SCRIPT_DIR}/../docker"
MCP_ENDPOINT="http://localhost:8000/mcp"
HEALTH_ENDPOINT="http://localhost:8000/health"
GROUP_ID="${GRAPHITI_GROUP_ID:-opendog}"

OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDOG_ROOT}/.opendog/bin:${PATH}"

usage() {
  cat <<'EOF'
Usage: graphiti-cli <command> [args]

Commands:
  start                   Start Neo4j + Graphiti services (injects secrets via config-cli)
  stop                    Stop all services
  status                  Show service status and health
  search <query>          Search facts in the knowledge graph
  search-nodes <query>    Search entity nodes in the knowledge graph
  remember <text> [flags] Store a new episode (fact/instruction/observation)
  episodes [--last N]     List recent episodes (default: last 10)
  help                    Show this help

Flags for 'remember':
  --source <source>       Source label (e.g., user-instruction, observation)
  --metadata key=value    Additional metadata (repeatable)
  --name <name>           Episode name (default: auto-generated from timestamp)

Environment:
  GRAPHITI_GROUP_ID       Group ID for partitioning (default: opendog)
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

cmd_start() {
  check_prereq docker
  check_prereq config-cli

  echo "Starting Graphiti services..."

  # Inject all secrets from config-cli vault
  local vault_output
  vault_output="$(config-cli get-all 2>/dev/null || echo "")"
  if [[ -n "$vault_output" ]]; then
    eval "$vault_output"
  fi

  docker compose -f "${DOCKER_DIR}/docker-compose.yml" up -d

  wait_for_health
  echo "Services are running. MCP endpoint: ${MCP_ENDPOINT}"
}

cmd_stop() {
  check_prereq docker
  echo "Stopping Graphiti services..."
  docker compose -f "${DOCKER_DIR}/docker-compose.yml" down
  echo "Services stopped."
}

cmd_status() {
  check_prereq docker
  echo "=== Docker Services ==="
  docker compose -f "${DOCKER_DIR}/docker-compose.yml" ps 2>/dev/null || echo "(not running)"
  echo ""
  echo "=== Health Check ==="
  if curl -sf "$HEALTH_ENDPOINT" 2>/dev/null; then
    echo ""
    echo "Graphiti: healthy"
  else
    echo "Graphiti: not reachable"
  fi
}

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

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)
        source="${2:?Error: --source requires a value}"
        shift 2
        ;;
      --metadata)
        metadata_pairs+=("${2:?Error: --metadata requires key=value}")
        shift 2
        ;;
      --name)
        episode_name="${2:?Error: --name requires a value}"
        shift 2
        ;;
      *)
        if [[ -z "$text" ]]; then
          text="$1"
        else
          text="${text} $1"
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$text" ]]; then
    echo "Error: No text provided." >&2
    exit 1
  fi

  # Auto-enrich metadata
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local hostname_val
  hostname_val="$(hostname)"
  local cwd_val
  cwd_val="$(pwd)"
  local project_val
  project_val="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "$cwd_val")")"

  if [[ -z "$episode_name" ]]; then
    episode_name="episode-$(date +%s)"
  fi

  # Build enriched body with context
  local body="${text}

---
source: ${source}
timestamp: ${timestamp}
hostname: ${hostname_val}
cwd: ${cwd_val}
project: ${project_val}"

  # Append user metadata
  for pair in "${metadata_pairs[@]+"${metadata_pairs[@]}"}"; do
    body="${body}
${pair}"
  done

  # Escape for JSON
  local body_escaped
  body_escaped="$(printf '%s' "$body" | jq -Rs .)"
  local name_escaped
  name_escaped="$(printf '%s' "$episode_name" | sed 's/"/\\"/g')"

  mcp call add_memory --params "{\"name\":\"${name_escaped}\",\"episode_body\":${body_escaped},\"group_id\":\"${GROUP_ID}\",\"source\":\"text\",\"source_description\":\"${source}\"}" \
    "$MCP_ENDPOINT"
}

cmd_episodes() {
  check_prereq mcp

  local last_n=10

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --last)
        last_n="${2:?Error: --last requires a number}"
        shift 2
        ;;
      *)
        echo "Error: Unknown flag '${1}'" >&2
        exit 1
        ;;
    esac
  done

  mcp call get_episodes --params "{\"group_ids\":[\"${GROUP_ID}\"],\"max_episodes\":${last_n}}" \
    "$MCP_ENDPOINT"
}

# Main dispatch
case "${1:-help}" in
  start)        shift; cmd_start ;;
  stop)         shift; cmd_stop ;;
  status)       shift; cmd_status ;;
  search)       shift; cmd_search "$@" ;;
  search-nodes) shift; cmd_search_nodes "$@" ;;
  remember)     shift; cmd_remember "$@" ;;
  episodes)     shift; cmd_episodes "$@" ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
