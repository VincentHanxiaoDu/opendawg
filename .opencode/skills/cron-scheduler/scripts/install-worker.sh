#!/usr/bin/env bash
# Install Cronicle as a worker node and connect it to the master server.
# Usage:
#   bash install-worker.sh --server <master_url> --secret <secret_key> [--tags <tags>]
set -euo pipefail

CRONICLE_SERVER=""
CRONICLE_SECRET=""
WORKER_TAGS=""
INSTALL_DIR="/opt/cronicle"
WORKER_PORT="3014"
CRONICLE_USER="cronicle"
# Pinned release — update intentionally when upgrading Cronicle
CRONICLE_VERSION="${CRONICLE_VERSION:-v0.9.106}"

usage() {
  cat <<'EOF'
Usage: install-worker.sh [options]

Install Cronicle worker and connect to master server.

Required:
  --server <url>          Master server URL (e.g., http://master:3012)
  --secret <key>          Shared secret key (must match master)

Optional:
  --tags <tags>           Comma-separated worker tags (e.g., ops,linux)
  --install-dir <path>    Installation directory (default: /opt/cronicle)
  --port <number>         Worker HTTP port (default: 3014, avoids conflict with Docker server on 3012)
  --uninstall             Remove Cronicle worker
  --uninstall --purge     Remove worker and all data

EOF
}

# Parse arguments
UNINSTALL=false
PURGE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)      CRONICLE_SERVER="${2:?Error: --server requires URL}"; shift 2 ;;
    --secret)      CRONICLE_SECRET="${2:?Error: --secret requires value}"; shift 2 ;;
    --tags)        WORKER_TAGS="${2:?Error: --tags requires value}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?Error: --install-dir requires path}"; shift 2 ;;
    --port)        WORKER_PORT="${2:?Error: --port requires number}"; shift 2 ;;
    --uninstall)   UNINSTALL=true; shift ;;
    --purge)       PURGE=true; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Error: Unknown option '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

# --- Uninstall ---
if [[ "$UNINSTALL" == true ]]; then
  echo "[worker-install] Uninstalling Cronicle worker..."
  if systemctl is-active cronicle &>/dev/null; then
    systemctl stop cronicle
  fi
  if systemctl is-enabled cronicle &>/dev/null; then
    systemctl disable cronicle
  fi
  rm -f /etc/systemd/system/cronicle.service
  systemctl daemon-reload 2>/dev/null || true

  if [[ "$PURGE" == true ]]; then
    echo "[worker-install] Purging ${INSTALL_DIR}..."
    rm -rf "$INSTALL_DIR"
  fi
  echo "[worker-install] Uninstalled."
  exit 0
fi

# --- Validate ---
if [[ -z "$CRONICLE_SERVER" ]]; then
  echo "Error: --server is required" >&2
  usage >&2
  exit 1
fi
if [[ -z "$CRONICLE_SECRET" ]]; then
  echo "Error: --secret is required" >&2
  usage >&2
  exit 1
fi

# --- Prerequisites ---
echo "[worker-install] Checking prerequisites..."
errors=0

if ! command -v node &>/dev/null; then
  echo "[worker-install] Node.js not found. Installing..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
    yum install -y nodejs
  elif command -v apk &>/dev/null; then
    apk add --no-cache nodejs npm
  elif command -v brew &>/dev/null; then
    brew install node@18
  else
    echo "Error: Cannot install Node.js automatically. Please install Node.js 18+ manually." >&2
    exit 1
  fi
fi

if ! command -v curl &>/dev/null; then
  echo "Error: 'curl' is required." >&2
  errors=1
fi

if [[ $errors -ne 0 ]]; then
  echo "Fix the errors above and re-run." >&2
  exit 1
fi

# --- Install Cronicle ---
echo "[worker-install] Installing Cronicle to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [[ ! -f "${INSTALL_DIR}/package.json" ]]; then
  echo "[worker-install] Downloading Cronicle ${CRONICLE_VERSION}..."
  curl -sL "https://github.com/jhuckaby/Cronicle/archive/refs/tags/${CRONICLE_VERSION}.tar.gz" | tar xz --strip-components=1
  npm install --production
  node bin/build.js dist
  echo "[worker-install] Cronicle ${CRONICLE_VERSION} installed."
else
  echo "[worker-install] Cronicle already installed, updating config..."
fi

# --- Configure as worker ---
echo "[worker-install] Configuring as worker..."

# Extract hostname from master URL for server_comm config
MASTER_HOST=$(echo "$CRONICLE_SERVER" | sed -E 's|https?://||' | sed -E 's|:[0-9]+||' | sed -E 's|/.*||')
MASTER_PORT=$(echo "$CRONICLE_SERVER" | grep -oE ':[0-9]+' | tr -d ':')
MASTER_PORT="${MASTER_PORT:-3012}"

# Build tags JSON array for server_groups (empty string → no groups)
TAGS_JSON="[]"
if [[ -n "$WORKER_TAGS" ]]; then
  TAGS_JSON=$(echo "$WORKER_TAGS" | tr ',' '\n' | jq -Rn '[inputs | select(length > 0)]')
fi

# Generate config.json for worker
cat > "${INSTALL_DIR}/conf/config.json" << CFGEOF
{
  "base_app_url": "${CRONICLE_SERVER}",
  "email_from": "cronicle@localhost",
  "smtp_hostname": "localhost",
  "secret_key": "${CRONICLE_SECRET}",
  "log_dir": "logs",
  "log_filename": "[component].log",
  "log_columns": ["hires_epoch", "date", "hostname", "pid", "component", "category", "code", "msg", "data"],
  "log_archive_path": "logs/archives/[yyyy]/[mm]/[dd]/[filename]-[yyyy]-[mm]-[dd].log.gz",
  "log_crashes": true,
  "copy_job_logs_to": "",
  "queue_dir": "queue",
  "pid_file": "logs/cronicled.pid",
  "debug_level": 6,
  "maintenance": "04:00",
  "list_row_max": 10000,
  "job_data_expire_days": 180,
  "child_kill_timeout": 10,
  "dead_job_timeout": 120,
  "master_ping_freq": 20,
  "master_ping_timeout": 60,
  "udp_broadcast_port": 3014,
  "scheduler_startup_grace": 10,
  "universal_web_hook": "",
  "track_manual_jobs": true,
  "max_jobs": 0,
  "no_add_server": false,
  "server_comm_use_hostnames": true,
  "web_direct_connect": false,
  "web_socket_use_hostnames": false,
  "socket_io_transports": ["websocket"],

  "WebServer": {
    "http_port": ${WORKER_PORT},
    "https_port": $(( WORKER_PORT + 1 )),
    "http_htdocs_dir": "htdocs",
    "http_max_upload_size": 104857600,
    "http_temp_dir": "/tmp",
    "http_gzip_opts": { "level": 6, "memLevel": 8 },
    "https": false,
    "https_force": false,
    "https_timeout": 30,
    "https_cert_file": "conf/ssl.crt",
    "https_key_file": "conf/ssl.key",
    "https_ca_file": ""
  },

  "Storage": {
    "engine": "Filesystem",
    "Filesystem": {
      "base_dir": "data",
      "key_namespaces": true
    }
  },

  "User": {
    "session_expire_days": 30,
    "max_failed_logins_per_hour": 5,
    "max_forgot_passwords_per_hour": 3,
    "free_accounts": false,
    "sort_global_users": true,
    "use_bcrypt": true
  },

  "email_templates": {
    "source": "conf/emails"
  },

  "server_groups": ${TAGS_JSON}
}
CFGEOF

echo "[worker-install] Config written."

# DO NOT run setup on worker — setup is only for the primary server.
# The worker will auto-discover and join the cluster via UDP broadcast
# or will be manually added via the Cronicle Web UI.

# --- Systemd service (if available) ---
if command -v systemctl &>/dev/null; then
  echo "[worker-install] Creating systemd service..."
  cat > /etc/systemd/system/cronicle.service << SVCEOF
[Unit]
Description=Cronicle Worker
After=network.target

[Service]
Type=forking
ExecStart=${INSTALL_DIR}/bin/control.sh start
ExecStop=${INSTALL_DIR}/bin/control.sh stop
PIDFile=${INSTALL_DIR}/logs/cronicled.pid
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable cronicle
  systemctl start cronicle
  echo "[worker-install] Cronicle worker started as systemd service."
else
  echo "[worker-install] systemd not available. Starting manually..."
  "${INSTALL_DIR}/bin/control.sh" start
  echo "[worker-install] Cronicle worker started."
  echo "[worker-install] NOTE: Worker will not auto-start on reboot. Add to your init system manually."
fi

# --- Verify connection ---
echo "[worker-install] Verifying connection to master..."
sleep 5
if curl -sf "${CRONICLE_SERVER}/api/app/get_schedule/v1?limit=1" &>/dev/null; then
  echo "[worker-install] Master is reachable at ${CRONICLE_SERVER}"
else
  echo "[worker-install] WARNING: Cannot reach master at ${CRONICLE_SERVER}"
  echo "[worker-install] The worker will retry connecting automatically."
fi

echo ""
echo "[worker-install] Installation complete!"
echo "  Install dir: ${INSTALL_DIR}"
echo "  Master: ${CRONICLE_SERVER}"
echo "  Config: ${INSTALL_DIR}/conf/config.json"
  [[ -n "$WORKER_TAGS" ]] && echo "  Tags: ${WORKER_TAGS} (written to config.json as server_groups)"
echo ""
echo "  To update tags after install, re-run install or edit:"
echo "  ${INSTALL_DIR}/conf/config.json (server_groups field)"
