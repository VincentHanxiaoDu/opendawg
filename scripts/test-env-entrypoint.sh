#!/bin/bash
set -euo pipefail

# ── Config from env / injected files ─────────────────────────────────────────
BOT_TOKEN="${TEST_BOT_TOKEN:?TEST_BOT_TOKEN is required}"
USER_ID="${TEST_USER_ID:-}"
ADMIN_ID="${TEST_ADMIN_ID:-$USER_ID}"
SERVER_PORT="${TEST_SERVER_PORT:-4097}"

echo "=== opendawg test environment (Rocky Linux) ==="
echo "  opencode server: :${SERVER_PORT}"
echo "  bot token:       ${BOT_TOKEN:0:10}..."
echo "  user:            ${USER_ID}"

# ── Symlink injected config if present ───────────────────────────────────────
# AGENTS.md
if [ -f /etc/opendawg/agents.md ]; then
    ln -sf /etc/opendawg/agents.md /opt/opendawg/AGENTS.md
    echo "  AGENTS.md:       injected"
fi

# .opencode directory (skills, commands, plugins)
if [ -d /etc/opendawg/opencode ] && [ "$(ls -A /etc/opendawg/opencode 2>/dev/null)" ]; then
    # Copy (not symlink) into .opencode so everything is writable
    mkdir -p /opt/opendawg/.opencode
    for item in /etc/opendawg/opencode/*; do
        base="$(basename "$item")"
        case "$base" in
            node_modules|bun.lock|.gitignore) continue ;;
        esac
        # Remove existing and copy fresh
        rm -rf "/opt/opendawg/.opencode/$base"
        cp -r "$item" "/opt/opendawg/.opencode/$base"
    done
    # Install opencode plugins if package.json was injected
    if [ -f /opt/opendawg/.opencode/package.json ]; then
        cd /opt/opendawg/.opencode && npm install --legacy-peer-deps 2>/dev/null || true
        cd /opt/opendawg
    fi
    echo "  .opencode:       injected"
fi

# opendawg.yaml — generate from env if not injected
if [ -f /etc/opendawg/opendawg.yaml ]; then
    cp /etc/opendawg/opendawg.yaml /opt/opendawg/opendawg.yaml
    echo "  opendawg.yaml:   injected"
else
    cat > /opt/opendawg/opendawg.yaml <<EOF
plugins:
  channel-telegram:
    enabled: true
    execution_mode: native
    config:
      bot_token: "${BOT_TOKEN}"
      allowed_user_ids: "${USER_ID}"
      admin_user_id: "${ADMIN_ID}"
      message_delete_timeout: 0
      server_url: "http://127.0.0.1:${SERVER_PORT}"
      media_dir: /tmp/media/telegram
EOF
    echo "  opendawg.yaml:   generated"
fi

# ── Export env vars for the telegram bot process ─────────────────────────────
export TELEGRAM_BOT_TOKENS="${BOT_TOKEN}"
export ALLOWED_USER_IDS="${USER_ID}"
export ADMIN_USER_ID="${ADMIN_ID}"
export MESSAGE_DELETE_TIMEOUT="0"
export OPENCODE_SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
export MEDIA_TMP_LOCATION="/tmp/media/telegram"

# ── Set OPENCODE_CONFIG_DIR so all sessions inherit .opencode config ─────────
export OPENCODE_CONFIG_DIR="/opt/opendawg/.opencode"

# ── Start opencode server in background ──────────────────────────────────────
echo ""
echo "Starting opencode server on :${SERVER_PORT}..."
echo "  OPENCODE_CONFIG_DIR=${OPENCODE_CONFIG_DIR}"
opencode serve --port "${SERVER_PORT}" --hostname 0.0.0.0 &
OPENCODE_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${SERVER_PORT}" >/dev/null 2>&1; then
        echo "opencode server ready (pid ${OPENCODE_PID})"
        break
    fi
    sleep 1
done

# ── Start telegram bot in foreground ─────────────────────────────────────────
echo "Starting telegram bot..."
cd /opt/opendawg/plugins/channel-telegram

# If opencode server dies, kill the bot too
trap "kill ${OPENCODE_PID} 2>/dev/null; exit" EXIT TERM INT

exec node dist/app.js
