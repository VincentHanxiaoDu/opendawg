#!/usr/bin/env bash
# _graphiti-lib.sh — Shared library for graphiti-memory plugin.
# Sourced by graphiti-cli.sh, graphiti-agent.sh. Not executed directly.

# --- Constants ---
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

BIN_DIR="${OPENDAWG_ROOT}/.opendawg/bin"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Defaults (overridden by env or vault) ---
GRAPHITI_PORT="${GRAPHITI_PORT:-8000}"
GRAPHITI_URL="${GRAPHITI_URL:-http://localhost:${GRAPHITI_PORT}}"
MCP_ENDPOINT="${GRAPHITI_URL}/mcp"
GRAPHITI_GROUP_ID="${GRAPHITI_GROUP_ID:-}"

# --- Utilities ---
die()         { echo "Error: $*" >&2; exit 1; }
require_arg() { [[ -n "${2:-}" ]] || die "$1"; }
format_json() { jq '.' 2>/dev/null || cat; }

# --- Vault helpers ---
vault_get() { config-cli get "$1" 2>/dev/null || true; }
vault_set() { config-cli set "$1" "$2" 2>/dev/null || true; }

# --- Config loading ---
load_config() {
  command -v config-cli &>/dev/null || return 0

  # GRAPHITI_GROUP_ID: env → vault → auto-default
  if [[ -z "$GRAPHITI_GROUP_ID" ]]; then
    GRAPHITI_GROUP_ID="$(vault_get GRAPHITI_GROUP_ID)"
  fi
  if [[ -z "$GRAPHITI_GROUP_ID" ]]; then
    GRAPHITI_GROUP_ID="opendawg-$(hostname -s)"
  fi

  # GRAPHITI_URL: env → vault
  if [[ "$GRAPHITI_URL" == "http://localhost:${GRAPHITI_PORT}" ]]; then
    local v; v="$(vault_get GRAPHITI_URL)"
    [[ -n "$v" ]] && GRAPHITI_URL="$v"
  fi

  # GRAPHITI_PORT: env → vault
  if [[ "$GRAPHITI_PORT" == "8000" ]]; then
    local v; v="$(vault_get GRAPHITI_PORT)"
    [[ -n "$v" ]] && GRAPHITI_PORT="$v"
  fi

  # Recompute MCP endpoint after URL resolution
  MCP_ENDPOINT="${GRAPHITI_URL}/mcp"
}

# --- MCP wrapper ---
mcp_call() {
  local tool="$1" params_json="$2"

  local mcp_bin=""
  if [[ -x "${BIN_DIR}/mcp" ]]; then
    mcp_bin="${BIN_DIR}/mcp"
  elif command -v mcp &>/dev/null; then
    mcp_bin="mcp"
  else
    die "mcp CLI not found. Install it first (see install.sh)."
  fi

  local result
  result=$("$mcp_bin" call "$tool" --params "$params_json" -f json "$MCP_ENDPOINT" 2>&1) || {
    echo "Error: MCP call to '${tool}' failed: ${result}" >&2
    return 1
  }
  echo "$result"
}

# --- Docker helpers ---
compose_cmd() {
  echo "docker compose --project-directory ${PLUGIN_DIR} -f ${PLUGIN_DIR}/docker-compose.yml"
}

# ============================================================
# Agent Commands
# ============================================================

cmd_search() {
  local query="${1:?Error: Query required. Usage: graphiti-agent search <query>}"
  local params
  params=$(jq -n \
    --arg q "$query" \
    --arg gid "$GRAPHITI_GROUP_ID" \
    '{query: $q, group_ids: [$gid]}')
  local result
  result=$(mcp_call "search_memory_facts" "$params") || return 1
  echo "$result" | format_json
}

cmd_search_nodes() {
  local query="${1:?Error: Query required. Usage: graphiti-agent search-nodes <query>}"
  local params
  params=$(jq -n \
    --arg q "$query" \
    --arg gid "$GRAPHITI_GROUP_ID" \
    '{query: $q, group_ids: [$gid]}')
  local result
  result=$(mcp_call "search_nodes" "$params") || return 1
  echo "$result" | format_json
}

cmd_remember() {
  local text="${1:?Error: Text required. Usage: graphiti-agent remember <text> [flags]}"
  shift
  local source="observation" metadata_pairs=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)   source="${2:?Error: --source requires a value}"; shift 2 ;;
      --metadata) metadata_pairs+=("${2:?Error: --metadata requires key=value}"); shift 2 ;;
      *) die "Unknown flag '$1'" ;;
    esac
  done

  # Auto-enrichment: hostname, cwd, timestamp
  local ts host cwd_path
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  host="$(hostname -s)"
  cwd_path="$(pwd)"

  # Build episode name with context
  local ep_name="${source}@${host} ${ts}"

  # Build metadata JSON
  local meta_json
  meta_json=$(jq -n \
    --arg source "$source" \
    --arg host "$host" \
    --arg cwd "$cwd_path" \
    --arg ts "$ts" \
    '{source: $source, hostname: $host, cwd: $cwd, timestamp: $ts}')

  # Merge user-provided metadata
  if [[ ${#metadata_pairs[@]} -gt 0 ]]; then
    for pair in "${metadata_pairs[@]}"; do
      local key="${pair%%=*}"
      local val="${pair#*=}"
      meta_json=$(echo "$meta_json" | jq --arg k "$key" --arg v "$val" '. + {($k): $v}')
    done
  fi

  # source_description must be a string — serialize metadata as compact JSON string
  local source_desc
  source_desc=$(echo "$meta_json" | jq -c '.')

  local params
  params=$(jq -n \
    --arg name "$ep_name" \
    --arg body "$text" \
    --arg gid "$GRAPHITI_GROUP_ID" \
    --arg src "$source_desc" \
    '{name: $name, episode_body: $body, group_id: $gid, source_description: $src}')

  local result
  result=$(mcp_call "add_memory" "$params") || return 1
  echo "Stored episode: ${ep_name}"
  echo "$result" | format_json
}

cmd_episodes() {
  local last=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --last) last="${2:?Error: --last requires a number}"; shift 2 ;;
      *) die "Unknown flag '$1'" ;;
    esac
  done

  local params
  params=$(jq -n \
    --arg gid "$GRAPHITI_GROUP_ID" \
    --argjson last "$last" \
    '{group_id: $gid, last_n: $last}')

  local result
  result=$(mcp_call "get_episodes" "$params") || return 1
  echo "$result" | format_json
}

cmd_get_edge() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent get-edge <uuid>}"
  local params
  params=$(jq -n --arg uuid "$uuid" '{uuid: $uuid}')
  local result
  result=$(mcp_call "get_entity_edge" "$params") || return 1
  echo "$result" | format_json
}

cmd_delete_episode() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent delete-episode <uuid>}"
  local params
  params=$(jq -n --arg uuid "$uuid" '{uuid: $uuid}')
  mcp_call "delete_episode" "$params" >/dev/null || return 1
  echo "Deleted episode: ${uuid}"
}

cmd_delete_edge() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent delete-edge <uuid>}"
  local params
  params=$(jq -n --arg uuid "$uuid" '{uuid: $uuid}')
  mcp_call "delete_entity_edge" "$params" >/dev/null || return 1
  echo "Deleted edge: ${uuid}"
}

cmd_health() {
  local result
  result=$(curl -sf --max-time 5 "${GRAPHITI_URL}/health" 2>&1) || {
    echo "UNHEALTHY: Cannot reach Graphiti at ${GRAPHITI_URL}" >&2
    return 1
  }
  echo "HEALTHY: Graphiti is running at ${GRAPHITI_URL}"
  echo "  MCP endpoint: ${MCP_ENDPOINT}"
  echo "  Group ID:     ${GRAPHITI_GROUP_ID}"
}
