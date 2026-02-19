#!/usr/bin/env bash
# Bootstrap and launch opencode in headless server mode.
# Same environment setup as opendawg-agent.sh, but runs `opencode serve`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
SKILLS_ROOT="$PROJECT_ROOT/.opencode/skills"

# --- Defaults ---
REPO_URL=""
REPO_BRANCH="main"
CONFIG_CLI_ENDPOINT=""
CONFIG_CLI_TOKEN=""
GRAPHITI_GROUP_ID="opendawg"
GRAPHITI_MODEL=""
LOG_LEVEL="DEBUG"
SERVER_PORT="4096"
SERVER_HOSTNAME="0.0.0.0"
SERVER_CORS=()
SERVER_PASSWORD=""
ENV_FILE=""
CHANNEL=""
START_GRAPHITI=false
START_CONFIG_CLI=false
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
  --graphiti-group-id <id>      Override graphiti group ID (default: opendawg)
  --graphiti-model <model>      Override graphiti model
  --env-file <path>             Load environment from .env file
  --log-level <level>           Log level for opencode (default: DEBUG)

Server Options:
  --port <number>               Port to listen on (default: 4096)
  --hostname <addr>             Hostname/address to bind (default: 127.0.0.1)
  --cors <origin>               Allowed CORS origin (can be repeated)
  --password <pass>             Enable HTTP Basic Auth (username: opencode)

Docker Service Options:
  --config-cli                  Start config-cli vault (Docker)
  --graphiti                    Start graphiti + neo4j knowledge graph (Docker)
  --channel <name>              Start a channel (Docker). Supported: telegram
  --start-all                   Start all Docker services above

  Each service must pass its health check before opencode serve starts.
  On Docker failure the script exits immediately.

  Telegram env vars (see .env.example):
    TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS,
    ADMIN_USER_ID, TELEGRAM_MESSAGE_DELETE_TIMEOUT

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
    --channel)
      CHANNEL="$2"; shift 2 ;;
    --channel=*)
      CHANNEL="${1#--channel=}"; shift ;;
    --graphiti)
      START_GRAPHITI=true; shift ;;
    --config-cli)
      START_CONFIG_CLI=true; shift ;;
    --start-all)
      START_CONFIG_CLI=true; START_GRAPHITI=true; CHANNEL="${CHANNEL:-telegram}"; shift ;;
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
  local cache_dir="${TMPDIR:-/tmp}/opendawg-agent-repo"

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
  OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  if [[ ! -d "${OPENDAWG_ROOT}/.opendawg/vault" ]]; then
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
      OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
      export PATH="${OPENDAWG_ROOT}/.opendawg/bin:$PATH"
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

# --- Step 6: Install opencode if missing, then auto-update ---
if ! command -v opencode &>/dev/null; then
  echo "[opencode-server] opencode not found — installing via Homebrew..."
  if command -v brew &>/dev/null; then
    brew install opencode
  else
    echo "[opencode-server] ERROR: brew not found. Install opencode manually:"
    echo "  https://opencode.ai/docs/install"
    exit 1
  fi
else
  echo "[opencode-server] opencode $(opencode --version 2>/dev/null || echo '?') — checking for updates..."
  opencode upgrade 2>/dev/null \
    || HOMEBREW_NO_AUTO_UPDATE=1 brew upgrade opencode 2>/dev/null \
    || true
  echo "[opencode-server] opencode $(opencode --version 2>/dev/null || echo '?') — ready"
fi

# --- Step 7: Launch opencode serve ---
# Use a dedicated working directory so opencode's file operations are isolated
SERVE_DIR="${PROJECT_ROOT}"
mkdir -p "$SERVE_DIR"

echo "[opencode-server] Launching opencode serve on ${SERVER_HOSTNAME}:${SERVER_PORT}..."
echo "[opencode-server] Working directory: ${SERVE_DIR}"

# Build serve args
SERVE_ARGS=(
  "--port" "$SERVER_PORT"
  "--hostname" "$SERVER_HOSTNAME"
  "--log-level" "$LOG_LEVEL"
)

for origin in "${SERVER_CORS[@]+"${SERVER_CORS[@]}"}"; do
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
export OPENCODE_CONFIG_DIR="$PROJECT_ROOT/.opencode"

# --- Docker service helpers ---
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
DOCKER_PROFILES=()          # profiles to activate
NEEDS_DOCKER=false          # true if any Docker service was requested

docker_up() {
  # Start services for the given profiles and wait for health checks.
  # Exits the script on failure.
  local profiles=("$@")
  local profile_args=()
  for p in "${profiles[@]}"; do
    profile_args+=("--profile" "$p")
  done

  echo "[opencode-server] docker compose up ${profiles[*]} ..."
  if ! docker compose -f "$COMPOSE_FILE" "${profile_args[@]}" up -d --wait; then
    echo "[opencode-server] ERROR: Docker services failed to start — aborting"
    docker compose -f "$COMPOSE_FILE" "${profile_args[@]}" logs --tail 40
    exit 1
  fi
  echo "[opencode-server] Docker services [${profiles[*]}] are healthy"
}

# Validate channel name early
if [[ -n "$CHANNEL" ]]; then
  case "$CHANNEL" in
    telegram)
      if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
        echo "[opencode-server] ERROR: --channel=telegram requires TELEGRAM_BOT_TOKEN in .env"
        exit 1
      fi
      ;;
    *)
      echo "[opencode-server] ERROR: unknown channel '$CHANNEL' (supported: telegram)"
      exit 1
      ;;
  esac
fi

# --- Step 8a: Start all Docker services (before opencode serve) ---
# Collect all requested profiles. Every service must be healthy before
# opencode serve starts.
DOCKER_PROFILES=()

if [[ "$START_CONFIG_CLI" = true ]]; then
  DOCKER_PROFILES+=(config-cli)
  NEEDS_DOCKER=true
fi

if [[ "$START_GRAPHITI" = true ]]; then
  DOCKER_PROFILES+=(graphiti)
  NEEDS_DOCKER=true
fi

if [[ -n "$CHANNEL" ]]; then
  DOCKER_PROFILES+=("$CHANNEL")
  NEEDS_DOCKER=true
fi

# Verify docker is available when any service is requested
if [[ "$NEEDS_DOCKER" = true ]]; then
  if ! command -v docker &>/dev/null; then
    echo "[opencode-server] ERROR: docker not found — required for --config-cli / --graphiti / --channel"
    exit 1
  fi
  if ! docker compose version &>/dev/null; then
    echo "[opencode-server] ERROR: docker compose plugin not found"
    exit 1
  fi
fi

# Start all Docker services and block until every one is healthy
if [[ ${#DOCKER_PROFILES[@]} -gt 0 ]]; then
  docker_up "${DOCKER_PROFILES[@]}"
fi

# --- Step 8b: Launch opencode serve ---
export OPENCODE_ENABLE_EXA=1
exec opencode serve "${SERVE_ARGS[@]}" ${OPENCODE_EXTRA_ARGS[@]+"${OPENCODE_EXTRA_ARGS[@]}"}
