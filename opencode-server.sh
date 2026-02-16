#!/usr/bin/env bash
# Bootstrap and launch opencode in headless server mode.
# Same environment setup as opencode-agent.sh, but runs `opencode serve`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
SKILLS_ROOT="$PROJECT_ROOT/.opencode/skills"

# --- Defaults ---
REPO_URL=""
REPO_BRANCH="main"
CONFIG_CLI_ENDPOINT=""
CONFIG_CLI_TOKEN=""
GRAPHITI_GROUP_ID="opendog"
GRAPHITI_MODEL=""
LOG_LEVEL="DEBUG"
SERVER_PORT="4096"
SERVER_HOSTNAME="127.0.0.1"
SERVER_CORS=()
SERVER_PASSWORD=""
ENV_FILE=""
OPENCODE_EXTRA_ARGS=()

# --- Help ---
show_help() {
  cat <<'HELPEOF'
Usage: opencode-server.sh [options] [opencode-args...]

Bootstrap and launch opencode as a headless server.

Environment & Skills Options:
  --repo <url>                  Git repo URL with .opencode/skills/ (required first run)
  --repo-branch <branch>        Branch to use (default: main)
  --config-cli-endpoint <url>   config-cli login endpoint URL
  --config-cli-token <token>    config-cli token (alternative to endpoint)
  --graphiti-group-id <id>      Override graphiti group ID (default: opendog)
  --graphiti-model <model>      Override graphiti model
  --env-file <path>             Load environment from .env file
  --log-level <level>           Log level for opencode (default: DEBUG)

Server Options:
  --port <number>               Port to listen on (default: 4096)
  --hostname <addr>             Hostname/address to bind (default: 127.0.0.1)
  --cors <origin>               Allowed CORS origin (can be repeated)
  --password <pass>             Enable HTTP Basic Auth (username: opencode)

General:
  -h, --help                    Show this help

All other arguments are passed through to opencode serve.

=== opencode serve help ===
HELPEOF
  opencode serve --help 2>/dev/null || echo "(opencode not yet installed)"
}

# --- Argument Parsing ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_URL="$2"; shift 2 ;;
    --repo-branch)
      REPO_BRANCH="$2"; shift 2 ;;
    --config-cli-endpoint)
      CONFIG_CLI_ENDPOINT="$2"; shift 2 ;;
    --config-cli-token)
      CONFIG_CLI_TOKEN="$2"; shift 2 ;;
    --graphiti-group-id)
      GRAPHITI_GROUP_ID="$2"; shift 2 ;;
    --graphiti-model)
      GRAPHITI_MODEL="$2"; shift 2 ;;
    --env-file)
      ENV_FILE="$2"; shift 2 ;;
    --log-level)
      LOG_LEVEL="$2"; shift 2 ;;
    --port)
      SERVER_PORT="$2"; shift 2 ;;
    --hostname)
      SERVER_HOSTNAME="$2"; shift 2 ;;
    --cors)
      SERVER_CORS+=("$2"); shift 2 ;;
    --password)
      SERVER_PASSWORD="$2"; shift 2 ;;
    -h|--help)
      show_help; exit 0 ;;
    *)
      OPENCODE_EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# --- Load .env file ---
if [[ -n "$ENV_FILE" ]] && [[ -f "$ENV_FILE" ]]; then
  echo "[opencode-server] Loading environment from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
elif [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[opencode-server] Loading environment from $PROJECT_ROOT/.env"
  set -a
  # shellcheck source=/dev/null
  source "$PROJECT_ROOT/.env"
  set +a
fi

# --- Step 2: Install skills from repo ---
install_skills() {
  local repo_url="$1"
  local branch="${2:-main}"
  local cache_dir="${TMPDIR:-/tmp}/opencode-agent-repo"

  echo "[opencode-server] Syncing skills from repo (branch: $branch)..."

  if [[ -d "$cache_dir/.git" ]]; then
    git -C "$cache_dir" fetch origin "$branch" --depth 1 2>/dev/null
    git -C "$cache_dir" checkout "origin/$branch" -- .opencode/ 2>/dev/null || true
  else
    git clone --depth 1 --branch "$branch" "$repo_url" "$cache_dir"
  fi

  if [[ -d "$cache_dir/.opencode" ]]; then
    mkdir -p "$PWD/.opencode"
    rsync -a --ignore-existing "$cache_dir/.opencode/" "$PWD/.opencode/"
    rsync -a "$cache_dir/.opencode/skills/" "$PWD/.opencode/skills/"
    echo "[opencode-server] Skills merged into $PWD/.opencode/"
  else
    echo "[opencode-server] Warning: repo has no .opencode/ directory"
  fi
}

if [[ -n "$REPO_URL" ]]; then
  install_skills "$REPO_URL" "$REPO_BRANCH"
fi

# --- Step 3: Detect config-cli availability ---
SKIP_CONFIG_CLI=false
SKIP_GRAPHITI=false

config_cli_requested() {
  [[ -n "$CONFIG_CLI_ENDPOINT" ]] || [[ -n "$CONFIG_CLI_TOKEN" ]]
}

if ! config_cli_requested && ! command -v config-cli &>/dev/null; then
  OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  if [[ ! -d "${OPENDOG_ROOT}/.opendog/vault" ]]; then
    echo "[opencode-server] Skipping config-cli — not installed and no auth flags provided"
    SKIP_CONFIG_CLI=true
    SKIP_GRAPHITI=true
  fi
fi

if [[ "$SKIP_CONFIG_CLI" = false ]]; then
  if ! command -v config-cli &>/dev/null; then
    CONFIG_CLI_INSTALL="$SKILLS_ROOT/config-cli/scripts/install.sh"
    if [[ -f "$CONFIG_CLI_INSTALL" ]]; then
      echo "[opencode-server] Installing config-cli..."
      bash "$CONFIG_CLI_INSTALL"
      OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
      export PATH="${OPENDOG_ROOT}/.opendog/bin:$PATH"
    else
      SKIP_CONFIG_CLI=true
      SKIP_GRAPHITI=true
    fi
  fi
fi

# --- Step 4: Config-cli auth ---
if [[ "$SKIP_CONFIG_CLI" = false ]]; then
  if [[ -n "$CONFIG_CLI_ENDPOINT" ]]; then
    echo "[opencode-server] Authenticating with config-cli endpoint..."
    config-cli login "$CONFIG_CLI_ENDPOINT"
  elif [[ -n "$CONFIG_CLI_TOKEN" ]]; then
    echo "[opencode-server] Authenticating with config-cli token..."
    config-cli login "https://auth?token=$CONFIG_CLI_TOKEN"
  fi
fi

# --- Step 5: Setup environment ---
# Env vars may already be set from .env file; config-cli overrides if available.
setup_env() {
  if [[ "$SKIP_CONFIG_CLI" = true ]]; then
    export GRAPHITI_GROUP_ID="$GRAPHITI_GROUP_ID"
    return
  fi

  if ! command -v config-cli &>/dev/null; then
    SKIP_GRAPHITI=true
    return
  fi

  local vault_output
  vault_output="$(config-cli get-all 2>/dev/null || echo "")"

  if [[ -z "$vault_output" ]]; then
    echo "[opencode-server] Config-cli vault is empty — using env vars from .env"
    return
  fi

  # Import all vault key-value pairs (overrides .env values)
  eval "$vault_output"
  echo "[opencode-server] Injected $(echo "$vault_output" | wc -l | tr -d ' ') keys from vault"

  # Flag overrides
  if [[ -n "$GRAPHITI_MODEL" ]]; then
    export MODEL_NAME="$GRAPHITI_MODEL"
  fi

  export GRAPHITI_GROUP_ID="$GRAPHITI_GROUP_ID"
}

setup_env

if [[ "$SKIP_GRAPHITI" = true ]]; then
  echo "[opencode-server] Skipping graphiti-memory — config-cli not available"
fi

# --- Step 6: Check/install/update opencode ---
CHECK_SCRIPT="$SCRIPT_DIR/check-opencode.sh"

if ! command -v opencode &>/dev/null; then
  echo "[opencode-server] opencode not found — installing via Homebrew..."
  if command -v brew &>/dev/null; then
    brew install opencode
  else
    echo "[opencode-server] ERROR: brew not found. Install opencode manually:"
    echo "  https://opencode.ai/docs/install"
    exit 1
  fi
elif [[ -f "$CHECK_SCRIPT" ]]; then
  echo "[opencode-server] Checking for opencode updates..."
  CHECK_OUTPUT=$(bash "$CHECK_SCRIPT" 2>/dev/null) && UPDATE_AVAILABLE=true || UPDATE_AVAILABLE=false
  echo "[opencode-server] $CHECK_OUTPUT"

  if [[ "$UPDATE_AVAILABLE" = true ]]; then
    echo "[opencode-server] Updating opencode..."
    if command -v brew &>/dev/null; then
      brew upgrade opencode 2>/dev/null || opencode upgrade 2>/dev/null || true
    else
      opencode upgrade 2>/dev/null || true
    fi
  fi
fi

# --- Step 7: Skip oh-my-opencode (TUI plugin, not needed for server) ---
echo "[opencode-server] Skipping oh-my-opencode — not applicable in server mode"

# --- Step 8: Launch opencode serve ---
# Use a dedicated working directory so opencode's file operations are isolated
SERVE_DIR="${PROJECT_ROOT}/opencode-server"
mkdir -p "$SERVE_DIR"

echo "[opencode-server] Launching opencode serve on ${SERVER_HOSTNAME}:${SERVER_PORT}..."
echo "[opencode-server] Working directory: ${SERVE_DIR}"

# Build serve args
SERVE_ARGS=(
  "--port" "$SERVER_PORT"
  "--hostname" "$SERVER_HOSTNAME"
  "--log-level" "$LOG_LEVEL"
)

for origin in "${SERVER_CORS[@]}"; do
  SERVE_ARGS+=("--cors" "$origin")
done

# Set auth env vars if password provided
if [[ -n "$SERVER_PASSWORD" ]]; then
  export OPENCODE_SERVER_PASSWORD="$SERVER_PASSWORD"
  echo "[opencode-server] HTTP Basic Auth enabled (user: opencode)"
elif [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
  echo "[opencode-server] HTTP Basic Auth enabled from environment (user: ${OPENCODE_SERVER_USERNAME:-opencode})"
fi

cd "$SERVE_DIR"
exec opencode serve "${SERVE_ARGS[@]}" "${OPENCODE_EXTRA_ARGS[@]}"
