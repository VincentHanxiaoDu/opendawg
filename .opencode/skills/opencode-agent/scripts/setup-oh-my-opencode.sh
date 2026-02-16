#!/usr/bin/env bash
# Setup oh-my-opencode: check version, install if missing, update if outdated.
# Consolidates check-update, install, and update logic into a single script.
# Exit codes: 0 = success, 1 = error
set -euo pipefail

PKG="oh-my-opencode"

# --- Detect package runner ---
detect_runner() {
  if command -v bun &>/dev/null; then
    RUNNER="bunx"
    INSTALLER="bun"
  elif command -v npx &>/dev/null; then
    RUNNER="npx"
    INSTALLER="npm"
  else
    echo "[oh-my-opencode] ERROR: Neither bun nor npm found." >&2
    echo "  bun: https://bun.sh" >&2
    echo "  npm: https://nodejs.org" >&2
    return 1
  fi
}

# --- Check version and update availability ---
check_version() {
  CURRENT=""
  LATEST=""
  INSTALLED=false

  # Get current version
  if command -v oh-my-opencode &>/dev/null; then
    CURRENT=$(oh-my-opencode version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
  fi

  if [[ -z "$CURRENT" ]]; then
    CURRENT=$($RUNNER "$PKG" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
  fi

  if [[ -n "$CURRENT" ]]; then
    INSTALLED=true
  fi

  # Fetch latest from npm
  LATEST=$(curl -s --max-time 5 "https://registry.npmjs.org/$PKG/latest" 2>/dev/null \
    | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
}

# --- Install oh-my-opencode ---
install_omo() {
  echo "[oh-my-opencode] Installing..."
  $RUNNER "$PKG" install "$@"
  echo "[oh-my-opencode] Installation complete."
  echo "[oh-my-opencode] Run '$RUNNER $PKG doctor' to verify your setup."
}

# --- Update oh-my-opencode ---
update_omo() {
  echo "[oh-my-opencode] Updating (${CURRENT:-unknown} → ${LATEST:-latest})..."

  if [[ "$INSTALLER" = "bun" ]]; then
    bun install -g "${PKG}@latest" 2>/dev/null || $RUNNER "${PKG}@latest" version
  else
    npm install -g "${PKG}@latest" 2>/dev/null || $RUNNER "${PKG}@latest" version
  fi

  # Verify
  local new_ver
  new_ver=$($RUNNER "$PKG" version 2>/dev/null || echo "unknown")
  echo "[oh-my-opencode] Updated to: $new_ver"

  # Post-update diagnostics
  $RUNNER "$PKG" doctor --no-tui 2>/dev/null || echo "[oh-my-opencode] Run '$RUNNER $PKG doctor' manually to check."
}

# --- Main entry point ---
run_setup() {
  detect_runner || return 1

  check_version

  if [[ "$INSTALLED" = false ]]; then
    echo "[oh-my-opencode] Not installed — running installer..."
    install_omo
    return $?
  fi

  echo "[oh-my-opencode] Installed: v${CURRENT}"

  if [[ -z "$LATEST" ]]; then
    echo "[oh-my-opencode] Could not check for updates (npm registry unreachable)."
    return 0
  fi

  if [[ "$CURRENT" = "$LATEST" ]]; then
    echo "[oh-my-opencode] Up to date (v${CURRENT})."
    return 0
  fi

  echo "[oh-my-opencode] Update available: v${CURRENT} → v${LATEST}"
  update_omo
}

# Run if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_setup
fi
