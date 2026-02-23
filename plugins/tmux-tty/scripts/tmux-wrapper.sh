#!/bin/bash
# Tmux wrapper for TTY operations — each session uses its own isolated socket
set -euo pipefail

SOCKET_DIR="${TMPDIR:-/tmp}/tmux-tty-sockets"
mkdir -p "$SOCKET_DIR"

ACTION="${1:-}"
SESSION_NAME="${2:-}"
SOCKET_PATH="$SOCKET_DIR/$SESSION_NAME"

tmux_cmd() {
  tmux -S "$SOCKET_PATH" "$@"
}

case "$ACTION" in
  start)
    COMMAND="${3:-bash}"
    shift 3 || true
    ARGS=("$@")

    # Kill stale session on same socket if exists
    tmux_cmd kill-server 2>/dev/null || true

    # Trap signals to clean up on interrupt during setup
    trap 'tmux_cmd kill-server 2>/dev/null; rm -f "$SOCKET_PATH"; exit 130' INT TERM

    if [ ${#ARGS[@]} -gt 0 ]; then
      tmux_cmd new-session -d -s "$SESSION_NAME" "$COMMAND" "${ARGS[@]}"
    else
      tmux_cmd new-session -d -s "$SESSION_NAME" "$COMMAND"
    fi

    sleep 0.3

    # Clear trap after successful start (session is now detached and managed)
    trap - INT TERM

    echo "Session: $SESSION_NAME (socket: $SOCKET_PATH)"
    echo "---"
    tmux_cmd capture-pane -t "$SESSION_NAME" -p
    ;;

  send)
    shift 2
    if [ $# -eq 0 ]; then
      echo "Error: No input provided" >&2
      exit 1
    fi

    tmux_cmd send-keys -t "$SESSION_NAME" "$@"
    sleep 0.2

    echo "Session: $SESSION_NAME"
    echo "---"
    tmux_cmd capture-pane -t "$SESSION_NAME" -p
    ;;

  capture)
    echo "Session: $SESSION_NAME"
    echo "---"
    tmux_cmd capture-pane -t "$SESSION_NAME" -p
    ;;

  stop)
    tmux_cmd kill-session -t "$SESSION_NAME" 2>/dev/null || true
    tmux_cmd kill-server 2>/dev/null || true
    rm -f "$SOCKET_PATH"
    echo "Session $SESSION_NAME terminated (socket removed)"
    ;;

  list)
    for sock in "$SOCKET_DIR"/*; do
      [ -S "$sock" ] || continue
      echo "=== $(basename "$sock") ==="
      tmux -S "$sock" list-sessions 2>/dev/null || echo "  (no active sessions)"
    done
    ;;

  cleanup)
    # Remove stale sockets (sockets with no running tmux server)
    cleaned=0
    for sock in "$SOCKET_DIR"/*; do
      [ -e "$sock" ] || continue
      if ! tmux -S "$sock" list-sessions &>/dev/null; then
        rm -f "$sock"
        echo "Removed stale socket: $(basename "$sock")"
        cleaned=$((cleaned + 1))
      fi
    done
    if [ "$cleaned" -eq 0 ]; then
      echo "No stale sockets found."
    else
      echo "Cleaned up $cleaned stale socket(s)."
    fi
    ;;

  *)
    cat <<EOF
Usage: $0 <action> <session-name> [args...]

Actions:
  start <name> <command> [args...]  - Start interactive session (isolated socket)
  send <name> <input>               - Send input (use Enter, Escape, C-c etc.)
  capture <name>                    - Capture current screen output
  stop <name>                       - Kill session and remove socket
  list                              - List all tmux-tty sessions
  cleanup                           - Remove stale sockets with no running server

Each session gets its own tmux socket at $SOCKET_DIR/<name>
so sessions are fully isolated from each other and the user's tmux.

Examples:
  $0 start py python3 -i
  $0 send py 'print("hello")' Enter
  $0 capture py
  $0 stop py
  $0 cleanup
EOF
    exit 1
    ;;
esac
