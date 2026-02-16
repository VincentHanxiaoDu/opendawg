#!/usr/bin/env bash
# Minimal HTTP server wrapping config-cli vault operations.
# Uses bash + socat for zero-dependency serving.
set -euo pipefail

PORT="${CONFIG_CLI_PORT:-9100}"
TOKEN="${CONFIG_CLI_TOKEN:?ERROR: CONFIG_CLI_TOKEN must be set}"
VAULT_DIR="/data/vault"

log() { echo "[config-cli-server] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

# --- Vault operations (same crypto as config-cli.sh) ---
vault_set() {
  local key="$1" value="$2"
  printf '%s' "$value" | openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:${TOKEN}" \
    -out "${VAULT_DIR}/${key}.enc" 2>/dev/null
  chmod 600 "${VAULT_DIR}/${key}.enc"
}

vault_get() {
  local key="$1"
  local enc_file="${VAULT_DIR}/${key}.enc"
  [[ -f "$enc_file" ]] || return 1
  openssl enc -aes-256-cbc -d -salt -pbkdf2 -pass "pass:${TOKEN}" -in "$enc_file" 2>/dev/null
}

vault_list() {
  for f in "${VAULT_DIR}"/*.enc; do
    [[ -f "$f" ]] || continue
    basename "$f" .enc
  done
}

vault_get_all() {
  for f in "${VAULT_DIR}"/*.enc; do
    [[ -f "$f" ]] || continue
    local key
    key="$(basename "$f" .enc)"
    local value
    value="$(openssl enc -aes-256-cbc -d -salt -pbkdf2 -pass "pass:${TOKEN}" -in "$f" 2>/dev/null)" || continue
    printf "export %s='%s'\n" "$key" "${value//\'/\'\\\'\'}"
  done
}

vault_delete() {
  local key="$1"
  rm -f "${VAULT_DIR}/${key}.enc"
}

# --- HTTP response helpers ---
respond() {
  local code="$1" body="$2"
  local len=${#body}
  printf 'HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "$code" "$len" "$body"
}

respond_json() {
  local code="$1" body="$2"
  local len=${#body}
  printf 'HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "$code" "$len" "$body"
}

# --- URL decode ---
urldecode() {
  local data="${1//+/ }"
  printf '%b' "${data//%/\\x}"
}

# --- Handle a single request ---
handle_request() {
  local method="" path="" query="" content_length=0 body="" auth_header=""

  # Read request line
  read -r line
  method=$(echo "$line" | awk '{print $1}')
  local full_path
  full_path=$(echo "$line" | awk '{print $2}')
  path="${full_path%%\?*}"
  query="${full_path#*\?}"
  [[ "$query" = "$full_path" ]] && query=""

  # Read headers
  while IFS= read -r header; do
    header="${header%%$'\r'}"
    [[ -z "$header" ]] && break
    case "${header,,}" in
      content-length:*) content_length="${header#*: }" ;;
      authorization:*)  auth_header="${header#*: }" ;;
    esac
  done

  # Read body if present
  if [[ "$content_length" -gt 0 ]]; then
    body=$(dd bs=1 count="$content_length" 2>/dev/null)
  fi

  # Auth check — require Bearer token matching CONFIG_CLI_TOKEN
  local expected_auth="Bearer ${TOKEN}"
  if [[ "$path" != "/health" ]] && [[ "$auth_header" != "$expected_auth" ]]; then
    respond "401 Unauthorized" "Unauthorized"
    return
  fi

  # Route
  case "$method:$path" in
    GET:/health)
      respond "200 OK" "ok"
      ;;
    GET:/list)
      local keys
      keys=$(vault_list)
      respond "200 OK" "$keys"
      ;;
    GET:/get-all)
      local all_exports
      all_exports=$(vault_get_all)
      respond "200 OK" "$all_exports"
      ;;
    GET:/get)
      local key
      key=$(urldecode "${query#key=}")
      if [[ -z "$key" ]]; then
        respond "400 Bad Request" "missing key parameter"
        return
      fi
      local value
      if value=$(vault_get "$key"); then
        respond "200 OK" "$value"
      else
        respond "404 Not Found" "key not found: $key"
      fi
      ;;
    POST:/set)
      # Parse body: key=<name>&value=<val>
      local key="" value=""
      IFS='&' read -ra params <<< "$body"
      for param in "${params[@]}"; do
        case "$param" in
          key=*)   key=$(urldecode "${param#key=}") ;;
          value=*) value=$(urldecode "${param#value=}") ;;
        esac
      done
      if [[ -z "$key" ]] || [[ -z "$value" ]]; then
        respond "400 Bad Request" "missing key or value"
        return
      fi
      vault_set "$key" "$value"
      respond "200 OK" "stored: $key"
      ;;
    DELETE:/delete)
      local key
      key=$(urldecode "${query#key=}")
      if [[ -z "$key" ]]; then
        respond "400 Bad Request" "missing key parameter"
        return
      fi
      vault_delete "$key"
      respond "200 OK" "deleted: $key"
      ;;
    GET:/status)
      local count=0
      for f in "${VAULT_DIR}"/*.enc; do
        [[ -f "$f" ]] || continue
        count=$((count + 1))
      done
      respond_json "200 OK" "{\"keys\": $count, \"authenticated\": true}"
      ;;
    *)
      respond "404 Not Found" "not found: $method $path"
      ;;
  esac
}

# --- If called with --handle, process a single request (socat child) ---
if [[ "${1:-}" = "--handle" ]]; then
  handle_request
  exit 0
fi

# --- Main entry point ---
mkdir -p "$VAULT_DIR"
chmod 700 "$VAULT_DIR"

log "Starting on port $PORT"
log "Vault: $VAULT_DIR"

# Use socat if available
if command -v socat &>/dev/null; then
  exec socat "TCP-LISTEN:${PORT},reuseaddr,fork" "SYSTEM:bash /app/config-cli-server.sh --handle"
fi

# Fallback: install socat and re-exec
apk add --no-cache socat >/dev/null 2>&1 || true
if command -v socat &>/dev/null; then
  exec socat "TCP-LISTEN:${PORT},reuseaddr,fork" "SYSTEM:bash /app/config-cli-server.sh --handle"
fi

log "ERROR: socat not available. Cannot start server."
exit 1
