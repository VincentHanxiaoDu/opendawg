#!/usr/bin/env bash
# Bootstrap and launch opencode with full environment and skills from a git repo.
# Only consumes its own flags; everything else passes through to opencode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_ROOT="$(cd "$SKILL_DIR/.." && pwd)"

# --- Defaults ---
REPO_URL=""
REPO_BRANCH="main"
CONFIG_CLI_ENDPOINT=""
CONFIG_CLI_TOKEN=""
GRAPHITI_GROUP_ID="opendog"
GRAPHITI_MODEL=""
SESSION_ID=""
LOG_LEVEL="DEBUG"
OPENCODE_EXTRA_ARGS=()

# --- Help ---
show_help() {
  cat <<'HELPEOF'
Usage: opencode-agent.sh [options] [opencode-args...]

Bootstrap and launch opencode with full environment and skills from a git repo.

Options:
  --repo <url>                  Git repo URL with .opencode/skills/ (required first run)
  --repo-branch <branch>        Branch to use (default: main)
  --config-cli-endpoint <url>   config-cli login endpoint URL
  --config-cli-token <token>    config-cli token (alternative to endpoint)
  --graphiti-group-id <id>      Override graphiti group ID (default: opendog)
  --graphiti-model <model>      Override graphiti model
  -s, --session <id>            Continue specific opencode session
  --log-level <level>           Log level for opencode (default: DEBUG)
  -h, --help                    Show this help

All other arguments are passed through to opencode.

Reload: quit opencode, then re-run with -s <session-id>

=== opencode help ===
HELPEOF
  opencode --help 2>/dev/null || echo "(opencode not yet installed)"
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
    -s|--session)
      SESSION_ID="$2"; shift 2 ;;
    --log-level)
      LOG_LEVEL="$2"; shift 2 ;;
    -h|--help)
      show_help; exit 0 ;;
    *)
      OPENCODE_EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# --- Step 2: Install skills from repo ---
install_skills() {
  local repo_url="$1"
  local branch="${2:-main}"
  local cache_dir="${TMPDIR:-/tmp}/opencode-agent-repo"

  echo "[opencode-agent] Syncing skills from repo (branch: $branch)..."

  # Clone or pull
  if [[ -d "$cache_dir/.git" ]]; then
    git -C "$cache_dir" fetch origin "$branch" --depth 1 2>/dev/null
    git -C "$cache_dir" checkout "origin/$branch" -- .opencode/ 2>/dev/null || true
  else
    git clone --depth 1 --branch "$branch" "$repo_url" "$cache_dir"
  fi

  # Merge .opencode/ into $PWD/.opencode/
  if [[ -d "$cache_dir/.opencode" ]]; then
    mkdir -p "$PWD/.opencode"
    # First pass: add new files without overwriting local-only content
    rsync -a --ignore-existing "$cache_dir/.opencode/" "$PWD/.opencode/"
    # Second pass: update skills to latest from repo
    rsync -a "$cache_dir/.opencode/skills/" "$PWD/.opencode/skills/"
    echo "[opencode-agent] Skills merged into $PWD/.opencode/"
  else
    echo "[opencode-agent] Warning: repo has no .opencode/ directory"
  fi
}

if [[ -n "$REPO_URL" ]]; then
  install_skills "$REPO_URL" "$REPO_BRANCH"
fi

# --- Step 3: Detect config-cli availability ---
# If no config-cli flags were provided AND config-cli isn't installed AND vault dir
# doesn't exist, skip config-cli and graphiti-memory entirely — don't bother the user.
SKIP_CONFIG_CLI=false
SKIP_GRAPHITI=false

config_cli_requested() {
  [[ -n "$CONFIG_CLI_ENDPOINT" ]] || [[ -n "$CONFIG_CLI_TOKEN" ]]
}

if ! config_cli_requested && ! command -v config-cli &>/dev/null; then
  # No flags, no binary — check if the vault dir exists (previous install)
  OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  if [[ ! -d "${OPENDOG_ROOT}/.opendog/vault" ]]; then
    echo "[opencode-agent] Skipping config-cli — not installed and no auth flags provided"
    SKIP_CONFIG_CLI=true
    SKIP_GRAPHITI=true
  fi
fi

if [[ "$SKIP_CONFIG_CLI" = false ]]; then
  # Ensure config-cli is installed
  if ! command -v config-cli &>/dev/null; then
    CONFIG_CLI_INSTALL="$SKILLS_ROOT/config-cli/scripts/install.sh"
    if [[ -f "$CONFIG_CLI_INSTALL" ]]; then
      echo "[opencode-agent] Installing config-cli..."
      bash "$CONFIG_CLI_INSTALL"
      OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
      export PATH="${OPENDOG_ROOT}/.opendog/bin:$PATH"
    else
      echo "[opencode-agent] Warning: config-cli not found and install script missing"
      echo "  Expected: $CONFIG_CLI_INSTALL"
      SKIP_CONFIG_CLI=true
      SKIP_GRAPHITI=true
    fi
  fi
fi

# --- Step 4: Config-cli auth ---
if [[ "$SKIP_CONFIG_CLI" = false ]]; then
  if [[ -n "$CONFIG_CLI_ENDPOINT" ]]; then
    echo "[opencode-agent] Authenticating with config-cli endpoint..."
    config-cli login "$CONFIG_CLI_ENDPOINT"
  elif [[ -n "$CONFIG_CLI_TOKEN" ]]; then
    echo "[opencode-agent] Authenticating with config-cli token..."
    config-cli login "https://auth?token=$CONFIG_CLI_TOKEN"
  fi
fi

# --- Step 5: Setup environment from config-cli vault ---
setup_env() {
  if [[ "$SKIP_CONFIG_CLI" = true ]]; then
    return
  fi

  if ! command -v config-cli &>/dev/null; then
    echo "[opencode-agent] Skipping env setup — config-cli not available"
    SKIP_GRAPHITI=true
    return
  fi

  local vault_output
  vault_output="$(config-cli get-all 2>/dev/null || echo "")"

  if [[ -z "$vault_output" ]]; then
    echo "[opencode-agent] Skipping env setup — config-cli vault is empty"
    SKIP_GRAPHITI=true
    return
  fi

  # Import all vault key-value pairs as environment variables
  eval "$vault_output"
  echo "[opencode-agent] Injected $(echo "$vault_output" | wc -l | tr -d ' ') keys from vault"

  # Flag overrides
  if [[ -n "$GRAPHITI_MODEL" ]]; then
    export MODEL_NAME="$GRAPHITI_MODEL"
  fi

  export GRAPHITI_GROUP_ID="$GRAPHITI_GROUP_ID"
}

setup_env

# --- Step 6: Check/install/update opencode ---
CHECK_SCRIPT="$SCRIPT_DIR/check-opencode.sh"

if ! command -v opencode &>/dev/null; then
  echo "[opencode-agent] opencode not found — installing via Homebrew..."
  if command -v brew &>/dev/null; then
    brew install opencode
  else
    echo "[opencode-agent] ERROR: brew not found. Install opencode manually:"
    echo "  https://opencode.ai/docs/install"
    exit 1
  fi
elif [[ -f "$CHECK_SCRIPT" ]]; then
  echo "[opencode-agent] Checking for opencode updates..."
  CHECK_OUTPUT=$(bash "$CHECK_SCRIPT" 2>/dev/null) && UPDATE_AVAILABLE=true || UPDATE_AVAILABLE=false
  echo "[opencode-agent] $CHECK_OUTPUT"

  if [[ "$UPDATE_AVAILABLE" = true ]]; then
    echo "[opencode-agent] Updating opencode..."
    if command -v brew &>/dev/null; then
      brew upgrade opencode 2>/dev/null || opencode upgrade 2>/dev/null || true
    else
      opencode upgrade 2>/dev/null || true
    fi
  fi
fi

# --- Step 7: Check/install/update oh-my-opencode ---
OMO_SETUP="$SCRIPT_DIR/setup-oh-my-opencode.sh"

if [[ -f "$OMO_SETUP" ]]; then
  echo "[opencode-agent] Setting up oh-my-opencode..."
  bash "$OMO_SETUP" || echo "[opencode-agent] Warning: oh-my-opencode setup had issues"
fi

# --- Step 8: Launch opencode ---
echo "[opencode-agent] Launching opencode..."

# Add session flag if provided
if [[ -n "$SESSION_ID" ]]; then
  OPENCODE_EXTRA_ARGS=("-s" "$SESSION_ID" "${OPENCODE_EXTRA_ARGS[@]}")
fi

exec opencode --log-level "$LOG_LEVEL" "${OPENCODE_EXTRA_ARGS[@]}"
