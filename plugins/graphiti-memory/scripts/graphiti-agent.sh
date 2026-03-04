#!/usr/bin/env bash
# graphiti-agent: Safe memory operations for AI agents.
# Wraps Graphiti MCP API. Per-item CRUD, search, remember.
# For admin operations (start/stop/clear), see graphiti-cli.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=_graphiti-lib.sh
source "${SCRIPT_DIR}/_graphiti-lib.sh"

usage() {
  cat <<'EOF'
Usage: graphiti-agent <command> [args]

Memory Operations:
  search <query>                      Search facts (semantic)
  search-nodes <query>                Search entity nodes
  remember <text> [flags]             Store a new episode
    --source <type>                   Source type (default: observation)
    --metadata <key=value>            Extra metadata (repeatable)
  episodes [--last N]                 List recent episodes (default: 10)
  get-edge <uuid>                     Get an entity edge by UUID
  delete-episode <uuid>               Delete one episode
  delete-edge <uuid>                  Delete one entity edge

System:
  health                              Service health check

Environment:
  GRAPHITI_URL                        Server URL (default: http://localhost:8000)
  GRAPHITI_GROUP_ID                   Memory namespace (default: opendawg-<hostname>)
EOF
}

# Load config from vault
load_config

case "${1:-help}" in
  search)         shift; cmd_search "$@" ;;
  search-nodes)   shift; cmd_search_nodes "$@" ;;
  remember)       shift; cmd_remember "$@" ;;
  episodes)       shift; cmd_episodes "$@" ;;
  get-edge)       shift; cmd_get_edge "$@" ;;
  delete-episode) shift; cmd_delete_episode "$@" ;;
  delete-edge)    shift; cmd_delete_edge "$@" ;;
  health)         shift; cmd_health "$@" ;;
  help|--help|-h) usage ;;
  start|stop|status|clear)
    echo "Error: '${1}' is not available in agent mode. Use graphiti-cli for admin operations." >&2
    exit 1
    ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
