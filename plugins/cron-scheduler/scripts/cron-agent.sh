#!/usr/bin/env bash
# cron-agent: Safe cron operations for AI agents.
# Wraps Cronicle REST API. Per-job CRUD, run-now, query history, callback.
# For admin operations (start/stop/install), see cron-cli.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_cron-lib.sh
source "${SCRIPT_DIR}/_cron-lib.sh"

usage() {
  cat <<'EOF'
Usage: cron-agent <command> [args]

Job Management:
  create <jobspec-json>               Create a job from JobSpec JSON
  update <id> <jobspec-json>          Update a job (partial)
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
    --script <cmd>          Run shell command, deliver output to session
    --prompt <text>         Inject prompt into session (or isolated agent)
    --isolated              Run prompt in new session, deliver result
    --name <name>           Job name (default: callback-<session>)
    --host <hostname>       Target host (default: current hostname)
    --server-url <url>      OpenCode server URL
    --auth <user:password>  Basic Auth for OpenCode server

Environment:
  CRONICLE_URL              Server URL (default: http://localhost:3012)
  CRONICLE_API_KEY          API key for authentication
  OPENCODE_SERVER_URL       OpenCode server URL for callbacks
  OPENCODE_AUTH             Basic Auth credentials (user:password)
EOF
}

# Load config from vault
load_config
require_api_key

case "${1:-help}" in
  create)     shift; cmd_create "$@" ;;
  update)     shift; cmd_update "$@" ;;
  delete)     shift; cmd_delete "$@" ;;
  enable)     shift; cmd_enable "$@" ;;
  disable)    shift; cmd_disable "$@" ;;
  run)        shift; cmd_run "$@" ;;
  list)       shift; cmd_list "$@" ;;
  get)        shift; cmd_get "$@" ;;
  history)    shift; cmd_history "$@" ;;
  execution)  shift; cmd_execution "$@" ;;
  active)     shift; cmd_active "$@" ;;
  health)     shift; cmd_health "$@" ;;
  callback)   shift; cmd_callback "$@" ;;
  help|--help|-h) usage ;;
  start|stop|status|install-cmd|clear)
    echo "Error: '${1}' is not available in agent mode. Use cron-cli for admin operations." >&2
    exit 1
    ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
