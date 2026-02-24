#!/usr/bin/env bash
##############################################################################
# start-server.sh — Start opencode server with proper config
#
# Reads port/hostname from opendawg.yaml (server section), with CLI flag
# overrides. Falls back to sensible defaults if yaml is absent.
#
# Usage:
#   ./scripts/start-server.sh                        # use yaml / defaults
#   ./scripts/start-server.sh --port 4096            # override port
#   ./scripts/start-server.sh --hostname 127.0.0.1   # override hostname
#   ./scripts/start-server.sh --bg                   # background (nohup)
##############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="${PROJECT_DIR}/opendawg.yaml"

# ── Read defaults from opendawg.yaml server section ──────────────────────────
yaml_value() {
    local key="$1"
    awk -v key="$key" '
        /^server:/ { in_server=1; next }
        /^[^ #]/ { in_server=0 }
        in_server && $1 == key":" {
            val=$2; gsub(/["'\'']/, "", val); print val; exit
        }
    ' "$CONFIG_FILE" 2>/dev/null
}

YAML_PORT=""
YAML_HOSTNAME=""
if [ -f "$CONFIG_FILE" ]; then
    YAML_PORT=$(yaml_value port)
    YAML_HOSTNAME=$(yaml_value hostname)
fi

# Defaults: yaml → fallback
PORT="${YAML_PORT:-4096}"
HOSTNAME="${YAML_HOSTNAME:-127.0.0.1}"
BG=false

# ── CLI flag overrides ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --hostname) HOSTNAME="$2"; shift 2 ;;
        --bg) BG=true; shift ;;
        *) shift ;;
    esac
done

# Set OPENCODE_CONFIG_DIR so all sessions inherit skills/commands/plugins
export OPENCODE_CONFIG_DIR="${PROJECT_DIR}/.opencode"

echo "opencode server"
echo "  port:              ${PORT}"
echo "  hostname:          ${HOSTNAME}"
echo "  OPENCODE_CONFIG_DIR: ${OPENCODE_CONFIG_DIR}"
echo ""

SERVE_ARGS=(--port "$PORT")
if [ "$HOSTNAME" != "127.0.0.1" ]; then
    SERVE_ARGS+=(--hostname "$HOSTNAME")
fi

if [ "$BG" = true ]; then
    nohup opencode serve "${SERVE_ARGS[@]}" \
        > "${PROJECT_DIR}/.opencode-server-${PORT}.log" 2>&1 &
    echo "Started in background (pid $!). Log: .opencode-server-${PORT}.log"
else
    exec opencode serve "${SERVE_ARGS[@]}"
fi
