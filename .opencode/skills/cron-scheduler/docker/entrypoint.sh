#!/bin/bash
# Cronicle Docker entrypoint — handles first-run setup, API key creation, and foreground start.
set -e

CRONICLE_DIR="/opt/cronicle"
DATA_DIR="${CRONICLE_DIR}/data"

# --- Configuration from environment ---
CRONICLE_SECRET="${CRONICLE_SECRET:-$(openssl rand -hex 16)}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-}"
CRONICLE_BASE_URL="${CRONICLE_BASE_URL:-http://localhost:3012}"
CRONICLE_ADMIN_PASSWORD="${CRONICLE_ADMIN_PASSWORD:-admin}"

# --- Update config.json from env vars ---
update_config() {
  local config="${CRONICLE_DIR}/conf/config.json"
  if [ ! -f "$config" ]; then
    echo "[entrypoint] ERROR: config.json not found"
    exit 1
  fi

  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('${config}', 'utf8'));
    cfg.secret_key = '${CRONICLE_SECRET}';
    cfg.base_app_url = '${CRONICLE_BASE_URL}';
    if (process.env.CRONICLE_PORT) {
      cfg.WebServer = cfg.WebServer || {};
      cfg.WebServer.http_port = parseInt(process.env.CRONICLE_PORT) || 3012;
    }
    fs.writeFileSync('${config}', JSON.stringify(cfg, null, 2));
  "
  echo "[entrypoint] Config updated (secret_key, base_app_url)"
}

# --- First-time setup ---
first_time_setup() {
  echo "[entrypoint] Running first-time setup..."
  "${CRONICLE_DIR}/bin/control.sh" setup
  touch "${DATA_DIR}/.setup_done"
  echo "[entrypoint] First-time setup complete."
}

# --- Background: create API key via admin session after Cronicle is ready ---
create_api_key_background() {
  if [ -z "$CRONICLE_API_KEY" ]; then
    return
  fi

  (
    echo "[api-key-setup] Waiting for Cronicle to become master..."
    local max_wait=180
    local waited=0

    # Wait for the server to respond as master
    # "session" = server IS master, requires auth
    # "master" = server is NOT yet master (keep waiting)
    while [ $waited -lt $max_wait ]; do
      local resp
      resp=$(curl -s http://localhost:3012/api/app/get_schedule/v1 2>/dev/null || echo "")
      if echo "$resp" | grep -qE '"code":"(session|api)"'; then
        echo "[api-key-setup] Cronicle master is ready (waited ${waited}s)."
        break
      fi
      sleep 3
      waited=$((waited + 3))
    done

    if [ $waited -ge $max_wait ]; then
      echo "[api-key-setup] ERROR: Timed out waiting for master. API key not created."
      return
    fi

    # Check if API key already works
    local test_resp
    test_resp=$(curl -s "http://localhost:3012/api/app/get_schedule/v1?limit=0" \
      -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo "")
    if echo "$test_resp" | grep -q '"code":0'; then
      echo "[api-key-setup] API key already active, skipping creation."
      return
    fi

    # Login as admin to get session_id
    echo "[api-key-setup] Logging in as admin..."
    local login_resp
    login_resp=$(curl -s -X POST http://localhost:3012/api/user/login \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"admin\",\"password\":\"${CRONICLE_ADMIN_PASSWORD}\"}" 2>&1)

    local login_code session_id
    login_code=$(echo "$login_resp" | jq -r '.code // "error"' 2>/dev/null)
    session_id=$(echo "$login_resp" | jq -r '.session_id // ""' 2>/dev/null)

    if [ "$login_code" != "0" ] || [ -z "$session_id" ]; then
      echo "[api-key-setup] ERROR: Admin login failed: $login_resp"
      return
    fi
    echo "[api-key-setup] Admin login successful."

    # Create API key using session_id in request body
    echo "[api-key-setup] Creating API key..."
    local create_resp
    create_resp=$(curl -s -X POST http://localhost:3012/api/app/create_api_key/v1 \
      -H "Content-Type: application/json" \
      -d "{
        \"session_id\": \"${session_id}\",
        \"key\": \"${CRONICLE_API_KEY}\",
        \"title\": \"Admin API Key\",
        \"active\": 1,
        \"privileges\": {
          \"admin\": 1,
          \"create_events\": 1,
          \"edit_events\": 1,
          \"delete_events\": 1,
          \"run_events\": 1,
          \"abort_events\": 1,
          \"state_update\": 1
        }
      }" 2>&1)

    local create_code
    create_code=$(echo "$create_resp" | jq -r '.code // "error"' 2>/dev/null)
    if [ "$create_code" = "0" ]; then
      echo "[api-key-setup] API key created successfully!"
    else
      echo "[api-key-setup] ERROR: API key creation failed: $create_resp"
    fi
  ) &
}

# --- Main ---
update_config

if [ ! -f "${DATA_DIR}/.setup_done" ]; then
  first_time_setup
fi

# Launch background API key creator (runs after Cronicle starts and becomes master)
create_api_key_background

echo "[entrypoint] Starting Cronicle (foreground)..."
exec node "${CRONICLE_DIR}/lib/main.js" --foreground --echo --color
