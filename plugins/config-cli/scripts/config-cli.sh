#!/usr/bin/env bash
set -euo pipefail

OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CONFIG_DIR="${OPENDAWG_ROOT}/.opendawg"
VAULT_DIR="${CONFIG_DIR}/vault"
TOKEN_FILE="${CONFIG_DIR}/.token"

usage() {
  cat <<'EOF'
Usage: config-cli <command> [args]

Commands:
  login <url>        Extract token from URL (?token=xxx) and store as master key
  set <key> <value>  Encrypt and store a value
  get <key>          Decrypt and output a value (for $(...) substitution)
  get-all            Decrypt all keys, output export KEY='VALUE' lines (for eval)
  list               List stored key names (never values)
  delete <key>       Remove a stored key
  status             Show auth status and key count
  help               Show this help
EOF
}

ensure_dirs() {
  mkdir -p "$VAULT_DIR"
  chmod 700 "$CONFIG_DIR"
  chmod 700 "$VAULT_DIR"
}

get_token() {
  if [[ ! -f "$TOKEN_FILE" ]]; then
    echo "Error: Not authenticated. Run 'config-cli login <url>' first." >&2
    exit 1
  fi
  cat "$TOKEN_FILE"
}

cmd_login() {
  local url="${1:?Error: URL required. Usage: config-cli login <url?token=xxx>}"
  local token

  # Extract token parameter from URL
  if [[ "$url" =~ [?\&]token=([^&]+) ]]; then
    token="${BASH_REMATCH[1]}"
  else
    echo "Error: No 'token' parameter found in URL." >&2
    exit 1
  fi

  ensure_dirs
  printf '%s' "$token" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "Authenticated successfully. Token stored."
}

cmd_set() {
  local key="${1:?Error: Key required. Usage: config-cli set <key> <value>}"
  local value="${2:?Error: Value required. Usage: config-cli set <key> <value>}"

  ensure_dirs
  local token
  token="$(get_token)"

  local enc_file="${VAULT_DIR}/${key}.enc"
  printf '%s' "$value" | openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:${token}" -out "$enc_file" 2>/dev/null
  chmod 600 "$enc_file"
  echo "Stored: ${key}"
}

cmd_get() {
  local key="${1:?Error: Key required. Usage: config-cli get <key>}"
  local token
  token="$(get_token)"

  local enc_file="${VAULT_DIR}/${key}.enc"
  if [[ ! -f "$enc_file" ]]; then
    echo "Error: Key '${key}' not found." >&2
    exit 1
  fi

  openssl enc -aes-256-cbc -d -salt -pbkdf2 -pass "pass:${token}" -in "$enc_file" 2>/dev/null
}

cmd_get_all() {
  local token
  token="$(get_token)"

  local found=0
  for f in "${VAULT_DIR}"/*.enc; do
    [[ -f "$f" ]] || continue
    local key
    key="$(basename "$f" .enc)"
    local value
    value="$(openssl enc -aes-256-cbc -d -salt -pbkdf2 -pass "pass:${token}" -in "$f" 2>/dev/null)"
    # Escape single quotes in value for safe eval
    value="${value//\'/\'\\\'\'}"
    printf "export %s='%s'\n" "$key" "$value"
    found=1
  done
  if [[ "$found" -eq 0 ]]; then
    return 0
  fi
}

cmd_list() {
  ensure_dirs
  local found=0
  for f in "${VAULT_DIR}"/*.enc; do
    [[ -f "$f" ]] || continue
    basename "$f" .enc
    found=1
  done
  if [[ "$found" -eq 0 ]]; then
    echo "(no keys stored)"
  fi
}

cmd_delete() {
  local key="${1:?Error: Key required. Usage: config-cli delete <key>}"
  local enc_file="${VAULT_DIR}/${key}.enc"
  if [[ ! -f "$enc_file" ]]; then
    echo "Error: Key '${key}' not found." >&2
    exit 1
  fi
  rm -f "$enc_file"
  echo "Deleted: ${key}"
}

cmd_status() {
  ensure_dirs
  if [[ -f "$TOKEN_FILE" ]]; then
    echo "Auth: authenticated"
  else
    echo "Auth: not authenticated"
  fi

  local count=0
  for f in "${VAULT_DIR}"/*.enc; do
    [[ -f "$f" ]] || continue
    count=$((count + 1))
  done
  echo "Keys: ${count}"
}

# Main dispatch
case "${1:-help}" in
  login)   shift; cmd_login "$@" ;;
  set)     shift; cmd_set "$@" ;;
  get)     shift; cmd_get "$@" ;;
  get-all) shift; cmd_get_all ;;
  list)    shift; cmd_list ;;
  delete)  shift; cmd_delete "$@" ;;
  status)  shift; cmd_status ;;
  help|--help|-h) usage ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
