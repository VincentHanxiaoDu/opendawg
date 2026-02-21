#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
BIN_DIR="${OPENDAWG_ROOT}/.opendawg/bin"

echo "=== cron-scheduler installer ==="

# Check prerequisites
errors=0

if ! command -v docker &>/dev/null; then
  echo "ERROR: 'docker' is required but not found. Install Docker Desktop." >&2
  errors=1
fi

if ! docker compose version &>/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin is required. Install Docker Compose V2." >&2
  errors=1
fi

if ! command -v curl &>/dev/null; then
  echo "ERROR: 'curl' is required but not found." >&2
  errors=1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: 'jq' is required but not found. Install it:" >&2
  echo "  brew install jq  # macOS" >&2
  echo "  apt-get install jq  # Debian/Ubuntu" >&2
  errors=1
fi

if [[ $errors -ne 0 ]]; then
  echo ""
  echo "Fix the errors above and re-run this installer."
  exit 1
fi

# Create bin directory
mkdir -p "$BIN_DIR"

# Make scripts executable and symlink
chmod +x "${SCRIPT_DIR}/cron-cli.sh"
chmod +x "${SCRIPT_DIR}/cron-agent.sh"
chmod +x "${SCRIPT_DIR}/cron-client.sh"
ln -sf "${SCRIPT_DIR}/cron-cli.sh" "${BIN_DIR}/cron-cli"
ln -sf "${SCRIPT_DIR}/cron-agent.sh" "${BIN_DIR}/cron-agent"
ln -sf "${SCRIPT_DIR}/cron-client.sh" "${BIN_DIR}/cron-client"
echo "Symlinked cron-cli    → ${BIN_DIR}/cron-cli"
echo "Symlinked cron-agent  → ${BIN_DIR}/cron-agent"
echo "Symlinked cron-client → ${BIN_DIR}/cron-client"

# Create default runners.conf if it doesn't exist
RUNNERS_CONF="${SCRIPT_DIR}/../runners.conf"
if [[ ! -f "$RUNNERS_CONF" ]]; then
  cat > "$RUNNERS_CONF" << 'REOF'
# Runner whitelist — one path per line.
# Only these runners are allowed in job execution.
# Lines starting with # are comments.
bash
/bin/bash
/bin/sh
curl
/usr/local/bin/job_runner
REOF
  echo "Created default runners.conf"
fi

# Check PATH
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  echo ""
  echo "WARNING: ${BIN_DIR} is not in your PATH."
  echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "  export PATH=\"\$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.opendawg/bin:\$PATH\""
  echo ""
fi

echo ""
echo "Installation complete. Three scripts installed:"
echo "  cron-cli    — Full admin (start/stop server + all job ops)"
echo "  cron-agent  — Safe agent subset (job CRUD, history, callback)"
echo "  cron-client — Host-side worker (install/status/uninstall)"
echo ""
echo "Setup steps:"
echo ""
echo "  1. Start the Cronicle server (auto-generates API key, writes to vault):"
echo "     cron-cli start"
echo ""
echo "  2. Install a worker on this host (reads config from vault):"
echo "     cron-client install"
echo ""
echo "  3. Test it:"
echo "     cron-agent health"
echo "     cron-client status"
echo ""
echo "  4. Schedule an agent callback:"
echo "     cron-agent callback --session ses_xxx --schedule '*/10 * * * *' --prompt 'do something'"
echo ""
echo "  Agents use cron-agent. Workers are managed via cron-client."
echo "  Server config is auto-propagated via config-cli vault."
