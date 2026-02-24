#!/usr/bin/env bash
##############################################################################
# deploy-test.sh — Build and deploy opendawg to an isolated test environment
#
# Usage:
#   ./scripts/deploy-test.sh              # rebuild & restart
#   ./scripts/deploy-test.sh --no-cache   # full rebuild (no Docker cache)
#   ./scripts/deploy-test.sh --logs       # rebuild, restart, tail logs
#   ./scripts/deploy-test.sh --stop       # stop test container
#   ./scripts/deploy-test.sh --status     # show container status
#
# Architecture:
#   Rocky Linux container (opendawg-test)
#   ├── opencode server :4097            ← fully inside container
#   └── telegram bot @hxd_opendawg_uat   ← connects to localhost:4097
#
#   Mac host exposes :4097 via port-forward for tailscale serve.
#
# Config injection:
#   The script copies these into the container at /etc/opendawg/:
#   - AGENTS.md            → agent instructions
#   - .opencode/           → skills, commands, plugins
#   - opendawg.yaml        → generated from env vars
##############################################################################
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME="opendawg-test-env"
CONTAINER_NAME="opendawg-test"
DOCKERFILE="Dockerfile.test-env"

# Test bot credentials
TEST_BOT_TOKEN="8679886023:AAG0u5EoQkj5zc6ZHMPnIyqNzROAzO0T4Fs"
TEST_USER_ID="7930109134"
TEST_ADMIN_ID="7930109134"
TEST_SERVER_PORT="4097"

# ── Helpers ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_stop() {
    if docker ps -aq -f name="^${CONTAINER_NAME}$" | grep -q .; then
        log "Stopping ${CONTAINER_NAME}..."
        docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
        docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
        ok "Stopped and removed."
    else
        warn "Container not found."
    fi
}

cmd_status() {
    echo ""
    echo -e "${BOLD}=== opendawg test environment ===${NC}"
    echo ""

    if docker ps -q -f name="^${CONTAINER_NAME}$" | grep -q .; then
        docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}" \
            -f name="^${CONTAINER_NAME}$"
        echo ""
        log "Recent logs:"
        docker logs --tail 15 "$CONTAINER_NAME" 2>&1
    else
        warn "Container '${CONTAINER_NAME}' is not running."
    fi

    echo ""
    echo -e "${BOLD}--- Production container ---${NC}"
    if docker ps -q -f name="^opendawg-channel-telegram-1$" | grep -q .; then
        docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}" \
            -f name="^opendawg-channel-telegram-1$"
    else
        warn "Production container not running."
    fi
    echo ""
}

cmd_build() {
    local docker_args=("$@")

    log "Building ${IMAGE_NAME} (Rocky Linux)..."

    docker build \
        -f "${PROJECT_DIR}/${DOCKERFILE}" \
        -t "${IMAGE_NAME}" \
        ${docker_args[@]:+"${docker_args[@]}"} \
        "${PROJECT_DIR}"

    ok "Image built: ${IMAGE_NAME}"
}

# Prepare injected config directory on the host
prepare_config() {
    local config_dir="${PROJECT_DIR}/.test-env-config"
    rm -rf "$config_dir"
    mkdir -p "$config_dir/opencode"

    # 1. AGENTS.md
    if [ -f "${PROJECT_DIR}/AGENTS.md" ]; then
        cp "${PROJECT_DIR}/AGENTS.md" "$config_dir/agents.md"
    fi

    # 2. .opencode contents (skills, commands, package.json)
    #    Resolve symlinks so they work inside the container
    if [ -d "${PROJECT_DIR}/.opencode" ]; then
        # Copy non-symlink files directly
        for item in "${PROJECT_DIR}/.opencode"/*; do
            base="$(basename "$item")"
            # Skip node_modules, bun.lock, .gitignore
            case "$base" in
                node_modules|bun.lock|.gitignore) continue ;;
            esac

            if [ -L "$item" ]; then
                # Resolve symlink and copy the target
                real="$(readlink -f "$item" 2>/dev/null || true)"
                if [ -n "$real" ] && [ -e "$real" ]; then
                    cp -r "$real" "$config_dir/opencode/$base"
                fi
            elif [ -d "$item" ]; then
                cp -r "$item" "$config_dir/opencode/$base"
            else
                cp "$item" "$config_dir/opencode/$base"
            fi
        done
    fi

    # 3. opendawg.yaml — generated for test env
    cat > "$config_dir/opendawg.yaml" <<EOF
plugins:
  channel-telegram:
    enabled: true
    execution_mode: native
    config:
      bot_token: "${TEST_BOT_TOKEN}"
      allowed_user_ids: "${TEST_USER_ID}"
      admin_user_id: "${TEST_ADMIN_ID}"
      message_delete_timeout: 0
      server_url: "http://127.0.0.1:${TEST_SERVER_PORT}"
      media_dir: /tmp/media/telegram
      voice_api_version: 2024-06-01
      voice_stt_deployment: whisper
      voice_tts_deployment: tts
      voice_tts_voice: alloy
EOF

    echo "$config_dir"
}

cmd_run() {
    log "Preparing config injection..."
    local config_dir
    config_dir="$(prepare_config)"

    log "Starting ${CONTAINER_NAME}..."
    log "  Server port: ${TEST_SERVER_PORT}"
    log "  Bot token:   ${TEST_BOT_TOKEN:0:10}..."
    log "  User ID:     ${TEST_USER_ID}"

    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart on-failure \
        -p "${TEST_SERVER_PORT}:${TEST_SERVER_PORT}" \
        -e TEST_BOT_TOKEN="$TEST_BOT_TOKEN" \
        -e TEST_USER_ID="$TEST_USER_ID" \
        -e TEST_ADMIN_ID="$TEST_ADMIN_ID" \
        -e TEST_SERVER_PORT="$TEST_SERVER_PORT" \
        -v opendawg-test-data:/data \
        -v "${config_dir}/agents.md:/etc/opendawg/agents.md:ro" \
        -v "${config_dir}/opencode:/etc/opendawg/opencode:ro" \
        -v "${config_dir}/opendawg.yaml:/etc/opendawg/opendawg.yaml:ro" \
        "$IMAGE_NAME" >/dev/null

    ok "Container started."

    # Set up SSH tunnel from colima VM to Mac host (colima port-forward workaround)
    # Kill any existing tunnel on this port first
    pkill -f "ssh.*-L ${TEST_SERVER_PORT}:127.0.0.1:${TEST_SERVER_PORT}.*colima" 2>/dev/null || true
    sleep 0.5
    colima ssh-config > /tmp/colima-ssh-config 2>/dev/null
    if [ -f /tmp/colima-ssh-config ]; then
        ssh -F /tmp/colima-ssh-config -N -f -L "${TEST_SERVER_PORT}:127.0.0.1:${TEST_SERVER_PORT}" colima 2>/dev/null
        if lsof -iTCP:"${TEST_SERVER_PORT}" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
            ok "Port ${TEST_SERVER_PORT} forwarded from colima VM to host."
        else
            warn "Port forward may not be active yet. Try: curl http://localhost:${TEST_SERVER_PORT}"
        fi
    else
        warn "Could not get colima SSH config. Port forwarding skipped."
    fi

    # Wait for health
    log "Waiting for health check (opencode server + telegram bot)..."
    local retries=30
    local i=0
    while [ $i -lt $retries ]; do
        local health
        health=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
        if [ "$health" = "healthy" ]; then
            ok "Container is healthy!"
            echo ""
            docker logs --tail 20 "$CONTAINER_NAME" 2>&1
            return 0
        fi
        sleep 2
        i=$((i + 1))
    done

    warn "Health check didn't pass in time. Showing logs:"
    docker logs --tail 40 "$CONTAINER_NAME" 2>&1
}

cmd_deploy() {
    local build_args=()

    for arg in "$@"; do
        case "$arg" in
            --no-cache) build_args+=("--no-cache") ;;
        esac
    done

    echo ""
    echo -e "${BOLD}=====================================${NC}"
    echo -e "${BOLD} opendawg test env deploy (Rocky 9)${NC}"
    echo -e "${BOLD}=====================================${NC}"
    echo ""
    echo -e "  ${CYAN}Image:${NC}       ${IMAGE_NAME}"
    echo -e "  ${CYAN}Container:${NC}   ${CONTAINER_NAME}"
    echo -e "  ${CYAN}OS:${NC}          Rocky Linux 9"
    echo -e "  ${CYAN}opencode:${NC}    :${TEST_SERVER_PORT} (inside container)"
    echo -e "  ${CYAN}Bot:${NC}         @hxd_opendawg_uat_bot"
    echo -e "  ${CYAN}Host port:${NC}   :${TEST_SERVER_PORT} → container :${TEST_SERVER_PORT}"
    echo ""

    # Step 1: Stop existing
    cmd_stop

    # Step 2: Build
    cmd_build ${build_args[@]:+"${build_args[@]}"}

    # Step 3: Run with config injection
    cmd_run

    echo ""
    echo -e "${BOLD}Endpoints:${NC}"
    echo -e "  Local:     http://localhost:${TEST_SERVER_PORT}"
    echo -e "  Tailnet:   https://hxd-work-mbp.tailc9e96c.ts.net:${TEST_SERVER_PORT}/"
    echo -e "             (requires: tailscale serve --bg --https ${TEST_SERVER_PORT} http://localhost:${TEST_SERVER_PORT})"
    echo ""
    ok "Deploy complete."
}

# ── Main ──────────────────────────────────────────────────────────────────────

TAIL_LOGS=false

case "${1:-}" in
    --stop)
        cmd_stop
        exit 0
        ;;
    --status)
        cmd_status
        exit 0
        ;;
    --help|-h)
        echo "Usage: $0 [--no-cache] [--logs] [--stop] [--status]"
        echo ""
        echo "  (default)    Rebuild image and restart test container"
        echo "  --no-cache   Docker build without cache"
        echo "  --logs       After deploy, tail container logs"
        echo "  --stop       Stop the test container"
        echo "  --status     Show status of test and prod containers"
        exit 0
        ;;
esac

for arg in "$@"; do
    if [ "$arg" = "--logs" ]; then
        TAIL_LOGS=true
    fi
done

cmd_deploy "$@"

if [ "$TAIL_LOGS" = true ]; then
    echo ""
    log "Tailing logs (Ctrl+C to stop)..."
    docker logs -f "$CONTAINER_NAME" 2>&1
fi
