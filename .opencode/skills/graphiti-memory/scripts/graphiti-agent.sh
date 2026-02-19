#!/usr/bin/env bash
# graphiti-agent: Safe memory operations for AI agents.
# Per-item CRUD only — no clear, no service management.
# For full admin access, see graphiti-cli.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ENDPOINT="http://localhost:8000/mcp"
GROUP_ID="${GRAPHITI_GROUP_ID:-opendawg}"

OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

usage() {
  cat <<'EOF'
Usage: graphiti-agent <command> [args]

Read:
  search <query>              Search facts in the knowledge graph
  search-nodes <query>        Search entity nodes
  episodes [--last N]         List recent episodes (default: 10)
  get-edge <uuid>             Get an entity edge by UUID

Write:
  remember <text> [flags]     Store a new episode

Delete (single item only):
  delete-episode <uuid>       Delete one episode by UUID
  delete-edge <uuid>          Delete one entity edge by UUID

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

# --- Read ---

cmd_search() {
  local query="${1:?Error: Query required. Usage: graphiti-agent search <query>}"
  check_prereq mcp
  check_prereq jq
  local query_escaped
  query_escaped="$(printf '%s' "$query" | jq -Rs .)"
  mcp call search_memory_facts --params "{\"query\":${query_escaped},\"group_ids\":[\"${GROUP_ID}\"]}" \
    "$MCP_ENDPOINT"
}

cmd_search_nodes() {
  local query="${1:?Error: Query required. Usage: graphiti-agent search-nodes <query>}"
  check_prereq mcp
  check_prereq jq
  local query_escaped
  query_escaped="$(printf '%s' "$query" | jq -Rs .)"
  mcp call search_nodes --params "{\"query\":${query_escaped},\"group_ids\":[\"${GROUP_ID}\"]}" \
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
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent get-edge <uuid>}"
  check_prereq mcp
  mcp call get_entity_edge --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

# --- Write ---

cmd_remember() {
  if [[ $# -lt 1 ]]; then
    echo "Error: Text required. Usage: graphiti-agent remember <text> [flags]" >&2
    exit 1
  fi
  check_prereq mcp

  local text=""
  local source="agent"
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

# --- Delete (single item) ---

cmd_delete_episode() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent delete-episode <uuid>}"
  check_prereq mcp
  mcp call delete_episode --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

cmd_delete_edge() {
  local uuid="${1:?Error: UUID required. Usage: graphiti-agent delete-edge <uuid>}"
  check_prereq mcp
  mcp call delete_entity_edge --params "{\"uuid\":\"${uuid}\"}" "$MCP_ENDPOINT"
}

# --- Dispatch ---
case "${1:-help}" in
  search)         shift; cmd_search "$@" ;;
  search-nodes)   shift; cmd_search_nodes "$@" ;;
  remember)       shift; cmd_remember "$@" ;;
  episodes)       shift; cmd_episodes "$@" ;;
  get-edge)       shift; cmd_get_edge "$@" ;;
  delete-episode) shift; cmd_delete_episode "$@" ;;
  delete-edge)    shift; cmd_delete_edge "$@" ;;
  help|--help|-h) usage ;;
  clear|start|stop|status)
    echo "Error: '$1' is not available in agent mode. Use graphiti-cli.sh for admin operations." >&2
    exit 1
    ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
