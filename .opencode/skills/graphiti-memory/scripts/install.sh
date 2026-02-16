#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
BIN_DIR="${OPENDOG_ROOT}/.opendog/bin"

echo "=== graphiti-cli installer ==="

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

if ! command -v "${BIN_DIR}/config-cli" &>/dev/null && ! command -v config-cli &>/dev/null; then
  echo "ERROR: 'config-cli' is required. Install it first:" >&2
  echo "  bash skills/config-cli/scripts/install.sh" >&2
  errors=1
fi

if ! command -v "${BIN_DIR}/mcp" &>/dev/null && ! command -v mcp &>/dev/null; then
  echo "ERROR: 'mcp' CLI is required. Install it first:" >&2
  echo "  cd \"\${TMPDIR:-/tmp}\" && git clone --depth 1 https://github.com/f/mcptools.git" >&2
  echo "  cd mcptools && CGO_ENABLED=0 go build -o \"\${OPENDOG_ROOT}/.opendog/bin/mcp\" ./cmd/mcptools" >&2
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

# Make script executable and symlink
chmod +x "${SCRIPT_DIR}/graphiti-cli.sh"
ln -sf "${SCRIPT_DIR}/graphiti-cli.sh" "${BIN_DIR}/graphiti-cli"
echo "Symlinked graphiti-cli → ${BIN_DIR}/graphiti-cli"

# Check PATH
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  echo ""
  echo "WARNING: ${BIN_DIR} is not in your PATH."
  echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "  export PATH=\"\$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.opendog/bin:\$PATH\""
  echo ""
fi

echo ""
echo "Installation complete. Setup steps:"
echo ""
echo "  1. Store your OpenAI API key:"
echo "     config-cli set OPENAI_API_KEY sk-proj-your-key"
echo ""
echo "  2. (Optional) Set a custom Neo4j password:"
echo "     config-cli set NEO4J_PASSWORD your-password"
echo ""
echo "  3. Start the services:"
echo "     graphiti-cli start"
echo ""
echo "  4. Test it:"
echo "     graphiti-cli remember \"This is a test fact\""
echo "     graphiti-cli search \"test\""
echo "     graphiti-cli episodes"
