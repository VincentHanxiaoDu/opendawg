#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENDOG_ROOT="${OPENDOG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CONFIG_DIR="${OPENDOG_ROOT}/.opendog"
VAULT_DIR="${CONFIG_DIR}/vault"
BIN_DIR="${OPENDOG_ROOT}/.opendog/bin"

echo "=== config-cli installer ==="

# Create config directories
echo "Creating ${CONFIG_DIR}..."
mkdir -p "$VAULT_DIR"
chmod 700 "$CONFIG_DIR"
chmod 700 "$VAULT_DIR"

# Create bin directory
mkdir -p "$BIN_DIR"

# Create wrapper script (avoids symlink to +x file which triggers macOS XProtect)
cat > "${BIN_DIR}/config-cli" <<WRAPPER
#!/usr/bin/env bash
exec bash "${SCRIPT_DIR}/config-cli.sh" "\$@"
WRAPPER
chmod +x "${BIN_DIR}/config-cli"
echo "Installed config-cli → ${BIN_DIR}/config-cli"

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
echo "Installation complete. Config stored in: ${CONFIG_DIR}"
echo ""
echo "Quick start:"
echo "  config-cli login \"http://localhost?token=YOUR_TOKEN\""
echo "  config-cli set OPENAI_API_KEY sk-xxx"
echo "  config-cli get OPENAI_API_KEY"
echo "  config-cli list"
