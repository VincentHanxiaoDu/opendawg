#!/usr/bin/env bash
# Check if opencode has an update available
# Exit codes: 0 = update available, 1 = up to date or error
set -euo pipefail

# Get current version
CURRENT=""
if command -v opencode &>/dev/null; then
  CURRENT=$(opencode --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
fi

if [ -z "$CURRENT" ]; then
  echo '{"installed": false, "message": "opencode not found"}'
  exit 1
fi

# Fetch latest version — try Homebrew formulae API first
LATEST=""
LATEST=$(curl -s --max-time 5 "https://formulae.brew.sh/api/formula/opencode.json" 2>/dev/null \
  | grep -o '"stable":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

# Fallback: opencode upgrade --dry-run
if [ -z "$LATEST" ]; then
  LATEST=$(opencode upgrade --dry-run 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | tail -1 || echo "")
fi

# Fallback: local brew info
if [ -z "$LATEST" ]; then
  LATEST=$(brew info --json=v2 opencode 2>/dev/null \
    | grep -o '"stable":{"version":"[^"]*"' | head -1 \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "")
fi

if [ -z "$LATEST" ]; then
  echo "{\"installed\": true, \"current\": \"$CURRENT\", \"latest\": \"unknown\", \"update_available\": false}"
  exit 1
fi

if [ "$CURRENT" = "$LATEST" ]; then
  echo "{\"installed\": true, \"current\": \"$CURRENT\", \"latest\": \"$LATEST\", \"update_available\": false}"
  exit 1
else
  echo "{\"installed\": true, \"current\": \"$CURRENT\", \"latest\": \"$LATEST\", \"update_available\": true}"
  exit 0
fi
