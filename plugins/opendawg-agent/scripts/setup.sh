#!/usr/bin/env bash
# One-time environment setup for opendawg-agent.
# Run once per machine/project to: sync skills, configure auth, inject secrets, install/update opencode.
# After setup completes, use opendawg-agent.sh for all subsequent interactions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_ROOT="$(cd "$SKILL_DIR/.." && pwd)"

REPO_URL=""
REPO_BRANCH="main"
CONFIG_CLI_ENDPOINT=""
CONFIG_CLI_TOKEN=""
GRAPHITI_GROUP_ID="${GRAPHITI_GROUP_ID:-opendawg-$(hostname -s)}"
GRAPHITI_MODEL=""

show_help() {
  cat <<'EOF'
Usage: setup.sh [options]

One-time environment setup for opendawg-agent. Run this before using opendawg-agent.sh.

Options:
  --repo <url>                  Git repo URL with .opencode/skills/ (required first run)
  --repo-branch <branch>        Branch to use (default: main)
  --config-cli-endpoint <url>   config-cli login endpoint URL
  --config-cli-token <token>    config-cli token (alternative to endpoint)
  --graphiti-group-id <id>      Override graphiti group ID (default: opendawg)
  --graphiti-model <model>      Override graphiti model
  -h, --help                    Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)                REPO_URL="$2"; shift 2 ;;
    --repo-branch)         REPO_BRANCH="$2"; shift 2 ;;
    --config-cli-endpoint) CONFIG_CLI_ENDPOINT="$2"; shift 2 ;;
    --config-cli-token)    CONFIG_CLI_TOKEN="$2"; shift 2 ;;
    --graphiti-group-id)   GRAPHITI_GROUP_ID="$2"; shift 2 ;;
    --graphiti-model)      GRAPHITI_MODEL="$2"; shift 2 ;;
    -h|--help)             show_help; exit 0 ;;
    *) echo "[setup] Unknown option: $1"; exit 1 ;;
  esac
done

# --- Step 1: Install skills from repo ---
if [[ -n "$REPO_URL" ]]; then
  cache_dir="${TMPDIR:-/tmp}/opendawg-agent-repo"
  echo "[setup] Syncing skills from repo (branch: $REPO_BRANCH)..."

  if [[ -d "$cache_dir/.git" ]]; then
    git -C "$cache_dir" fetch origin "$REPO_BRANCH" --depth 1 2>/dev/null
    git -C "$cache_dir" checkout "origin/$REPO_BRANCH" -- .opencode/ 2>/dev/null || true
  else
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$cache_dir"
  fi

  if [[ -d "$cache_dir/.opencode" ]]; then
    mkdir -p "$PWD/.opencode"
    rsync -a --ignore-existing "$cache_dir/.opencode/" "$PWD/.opencode/"
    rsync -a "$cache_dir/.opencode/skills/" "$PWD/.opencode/skills/"
    echo "[setup] Skills merged into $PWD/.opencode/"
  else
    echo "[setup] Warning: repo has no .opencode/ directory"
  fi
fi

# --- Step 2: Config-cli install + auth ---
SKIP_CONFIG_CLI=false

config_cli_requested() {
  [[ -n "$CONFIG_CLI_ENDPOINT" ]] || [[ -n "$CONFIG_CLI_TOKEN" ]]
}

if ! config_cli_requested && ! command -v config-cli &>/dev/null; then
  OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  if [[ ! -d "${OPENDAWG_ROOT}/.opendawg/vault" ]]; then
    echo "[setup] Skipping config-cli — not installed and no auth flags provided"
    SKIP_CONFIG_CLI=true
  fi
fi

if [[ "$SKIP_CONFIG_CLI" = false ]] && ! command -v config-cli &>/dev/null; then
  CONFIG_CLI_INSTALL="$SKILLS_ROOT/config-cli/scripts/install.sh"
  if [[ -f "$CONFIG_CLI_INSTALL" ]]; then
    echo "[setup] Installing config-cli..."
    bash "$CONFIG_CLI_INSTALL"
    OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
    export PATH="${OPENDAWG_ROOT}/.opendawg/bin:$PATH"
  else
    echo "[setup] Warning: config-cli install script not found at $CONFIG_CLI_INSTALL"
    SKIP_CONFIG_CLI=true
  fi
fi

if [[ "$SKIP_CONFIG_CLI" = false ]]; then
  if [[ -n "$CONFIG_CLI_ENDPOINT" ]]; then
    echo "[setup] Authenticating with config-cli endpoint..."
    config-cli login "$CONFIG_CLI_ENDPOINT"
  elif [[ -n "$CONFIG_CLI_TOKEN" ]]; then
    echo "[setup] Authenticating with config-cli token..."
    config-cli login "https://auth?token=$CONFIG_CLI_TOKEN"
  fi
fi

# --- Step 3: Inject environment from vault ---
if [[ "$SKIP_CONFIG_CLI" = false ]] && command -v config-cli &>/dev/null; then
  vault_output="$(config-cli get-all 2>/dev/null || echo "")"
  if [[ -n "$vault_output" ]]; then
    eval "$vault_output"
    echo "[setup] Injected $(echo "$vault_output" | wc -l | tr -d ' ') keys from vault"
  else
    echo "[setup] Config-cli vault is empty"
  fi
fi

if [[ -n "$GRAPHITI_MODEL" ]]; then
  export MODEL_NAME="$GRAPHITI_MODEL"
fi
export GRAPHITI_GROUP_ID="$GRAPHITI_GROUP_ID"

# --- Step 4: Enable Exa web search ---
export OPENCODE_ENABLE_EXA=1

# --- Step 5: Install or update opencode ---
if ! command -v opencode &>/dev/null; then
  echo "[setup] opencode not found — installing via Homebrew..."
  if command -v brew &>/dev/null; then
    brew install opencode
  else
    echo "[setup] ERROR: brew not found. Install opencode manually: https://opencode.ai/docs/install"
    exit 1
  fi
else
  echo "[setup] opencode $(opencode --version 2>/dev/null || echo '?') — checking for updates..."
  opencode upgrade 2>/dev/null \
    || HOMEBREW_NO_AUTO_UPDATE=1 brew upgrade opencode 2>/dev/null \
    || true
fi

echo "[setup] opencode $(opencode --version 2>/dev/null || echo '?') — ready"

# --- Step 6: Install cron worker (if server config exists in vault) ---
if [[ "$SKIP_CONFIG_CLI" = false ]] && command -v config-cli &>/dev/null; then
  CRON_URL="$(config-cli get CRONICLE_URL 2>/dev/null || true)"
  CRON_SECRET="$(config-cli get CRONICLE_SECRET 2>/dev/null || true)"

  if [[ -n "$CRON_URL" && -n "$CRON_SECRET" ]]; then
    CRON_CLIENT_SCRIPT="$SKILLS_ROOT/cron-scheduler/scripts/cron-client.sh"
    if [[ -f "$CRON_CLIENT_SCRIPT" ]]; then
      # Install cron-scheduler skill first (ensures cron-client is on PATH)
      CRON_INSTALL="$SKILLS_ROOT/cron-scheduler/scripts/install.sh"
      if [[ -f "$CRON_INSTALL" ]]; then
        bash "$CRON_INSTALL" 2>/dev/null || true
      fi
      echo "[setup] Cron server found in vault (${CRON_URL}). Installing worker..."
      bash "$CRON_CLIENT_SCRIPT" install --server-url "$CRON_URL" --secret "$CRON_SECRET" 2>/dev/null \
        && echo "[setup] Cron worker installed and connected." \
        || echo "[setup] Warning: Cron worker installation failed (non-fatal)."
    fi
  else
    echo "[setup] Skipping cron worker — no CRONICLE_URL/CRONICLE_SECRET in vault"
  fi
fi

echo "[setup] Setup complete. Use opendawg-agent.sh to run tasks."
