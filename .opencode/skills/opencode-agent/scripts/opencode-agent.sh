#!/usr/bin/env bash
# Launch opencode. Lightweight — no setup, no updates, no network calls.
# Run setup.sh first to prepare the environment.
set -euo pipefail

SESSION_ID=""
LOG_LEVEL="DEBUG"
USE_TUI=false
CONTINUE_LAST=false
OPENCODE_EXTRA_ARGS=()

show_help() {
  cat <<'EOF'
Usage: opencode-agent.sh [options] [prompt...]

Launch opencode for a task. Run setup.sh first to prepare the environment.

Options:
  -s, --session <id>   Continue specific session
  -c, --continue       Continue the last session
  --tui                Launch interactive TUI instead of CLI mode
  --log-level <level>  Log level (default: DEBUG)
  -h, --help           Show this help

All other arguments are passed through to opencode.

Session workflow:
  1st run:  opencode-agent.sh "/opendog build auth"
            → [opencode-agent] session=ses_abc123
  2nd run:  opencode-agent.sh -s ses_abc123 "/opendog add tests"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session)  SESSION_ID="$2"; shift 2 ;;
    -c|--continue) CONTINUE_LAST=true; shift ;;
    --tui)         USE_TUI=true; shift ;;
    --log-level)   LOG_LEVEL="$2"; shift 2 ;;
    -h|--help)     show_help; exit 0 ;;
    *)             OPENCODE_EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if ! command -v opencode &>/dev/null; then
  echo "[opencode-agent] ERROR: opencode not found. Run setup.sh first."
  exit 1
fi

SESSION_ARGS=()
if [[ -n "$SESSION_ID" ]]; then
  SESSION_ARGS=("-s" "$SESSION_ID")
elif [[ "$CONTINUE_LAST" = true ]]; then
  SESSION_ARGS=("-c")
fi

if [[ "$USE_TUI" = true ]]; then
  exec opencode --log-level "$LOG_LEVEL" \
    ${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"} \
    ${OPENCODE_EXTRA_ARGS[@]+"${OPENCODE_EXTRA_ARGS[@]}"}
elif [[ -n "$SESSION_ID" ]] || [[ "$CONTINUE_LAST" = true ]]; then
  exec opencode run --log-level "$LOG_LEVEL" \
    ${SESSION_ARGS[@]+"${SESSION_ARGS[@]}"} \
    ${OPENCODE_EXTRA_ARGS[@]+"${OPENCODE_EXTRA_ARGS[@]}"}
else
  OUTPUT_FILE="${TMPDIR:-/tmp}/opencode-agent-output.$$"
  trap 'rm -f "$OUTPUT_FILE"' EXIT

  opencode run --format json --log-level "$LOG_LEVEL" \
    ${OPENCODE_EXTRA_ARGS[@]+"${OPENCODE_EXTRA_ARGS[@]}"} \
    | tee "$OUTPUT_FILE"
  OC_EXIT=${PIPESTATUS[0]}

  CAPTURED_SID=$(grep -o '"sessionID":"[^"]*"' "$OUTPUT_FILE" | head -1 | cut -d'"' -f4)
  if [[ -n "$CAPTURED_SID" ]]; then
    echo "[opencode-agent] session=$CAPTURED_SID"
  fi

  exit "$OC_EXIT"
fi
