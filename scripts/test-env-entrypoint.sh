#!/bin/bash
set -euo pipefail

BOT_TOKEN="${TEST_BOT_TOKEN:?TEST_BOT_TOKEN is required}"
USER_ID="${TEST_USER_ID:-}"
ADMIN_ID="${TEST_ADMIN_ID:-$USER_ID}"
SERVER_URL="${TEST_SERVER_URL:-http://host.docker.internal:4096}"

echo "=== opendawg test environment ==="
echo "Configuring test Telegram bot..."

# Write opendawg.yaml for the test environment
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
      server_urls: ""
      server_url: "${SERVER_URL}"
      media_dir: /tmp/media/telegram
      voice_api_version: 2024-06-01
      voice_stt_deployment: whisper
      voice_tts_deployment: tts
      voice_tts_voice: alloy
EOF

echo "Config written. Starting Telegram bot directly..."

# Export env vars the app expects (bypass the opendawg CLI layer)
export TELEGRAM_BOT_TOKENS="${BOT_TOKEN}"
export ALLOWED_USER_IDS="${USER_ID}"
export ADMIN_USER_ID="${ADMIN_ID}"
export MESSAGE_DELETE_TIMEOUT="0"
export OPENCODE_SERVER_URL="${SERVER_URL}"
export MEDIA_TMP_LOCATION="/tmp/media/telegram"

# Start the telegram bot directly (no Docker-in-Docker)
cd /opt/opendawg/plugins/channel-telegram
exec node dist/app.js
