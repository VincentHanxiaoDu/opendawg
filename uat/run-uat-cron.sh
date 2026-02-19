#!/usr/bin/env bash
# =============================================================================
# uat/run-uat-cron.sh — Host-side launcher for the cron-scheduler UAT
#
# Architecture (no DinD required):
#   Host Docker socket is mounted into the Rocky Linux UAT container.
#   Cronicle is started as a sibling container on a named Docker network.
#   UAT container reaches Cronicle by container name over that network.
#
#   ┌─────────────────────────────────────────────────────────┐
#   │  Host Docker                                            │
#   │   ┌─────────────────────┐   ┌────────────────────────┐ │
#   │   │ opendog-uat-cron     │   │ uat-cronicle           │ │
#   │   │ (Rocky Linux 9)     │──▶│ (Cronicle + mock bins) │ │
#   │   │ mounts docker.sock  │   │ port 3012              │ │
#   │   └─────────────────────┘   └────────────────────────┘ │
#   │         both on: uat-cron-net                           │
#   └─────────────────────────────────────────────────────────┘
#
# Usage:
#   bash uat/run-uat-cron.sh [--no-cache] [--keep]
#
#   --no-cache   force full Docker image rebuilds
#   --keep       don't remove containers on exit (for debugging)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

UAT_IMAGE="opendog-uat-cron"
CRONICLE_IMAGE="opendog-cronicle-uat"
UAT_CONTAINER="opendog-uat-cron-run"
CRONICLE_CONTAINER="uat-cronicle"
UAT_NETWORK="uat-cron-net"
NO_CACHE=""
KEEP=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-cache) NO_CACHE="--no-cache"; shift ;;
        --keep)     KEEP=true; shift ;;
        -h|--help)
            echo "Usage: bash uat/run-uat-cron.sh [--no-cache] [--keep]"
            exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

log()  { echo -e "\033[0;34m[run-uat]\033[0m $*"; }
ok()   { echo -e "\033[0;32m[run-uat]\033[0m $*"; }
err()  { echo -e "\033[0;31m[run-uat]\033[0m $*" >&2; }
bold() { echo -e "\033[1m$*\033[0m"; }

cleanup() {
    if [[ "$KEEP" == true ]]; then
        log "Containers preserved (--keep). To clean up:"
        log "  docker rm -f ${UAT_CONTAINER} ${CRONICLE_CONTAINER}"
        log "  docker network rm ${UAT_NETWORK}"
        return
    fi
    log "Cleaning up..."
    docker rm -f "${UAT_CONTAINER}"    &>/dev/null || true
    docker rm -f "${CRONICLE_CONTAINER}" &>/dev/null || true
    docker network rm "${UAT_NETWORK}" &>/dev/null || true
    ok "Cleanup done"
}
trap cleanup EXIT

# Pre-flight
if ! command -v docker &>/dev/null; then
    err "Docker not found."; exit 1
fi
if ! docker info &>/dev/null 2>&1; then
    err "Docker daemon not running."; exit 1
fi

echo ""
bold "════════════════════════════════════════════════════"
bold "  cron-scheduler UAT  —  Rocky Linux 9 environment"
bold "  $(date)"
bold "════════════════════════════════════════════════════"
echo ""

# ── 1. Clean up stale containers ─────────────────────────────
for c in "${UAT_CONTAINER}" "${CRONICLE_CONTAINER}"; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${c}$"; then
        log "Removing stale container: ${c}"
        docker rm -f "$c" &>/dev/null
    fi
done
docker network rm "${UAT_NETWORK}" &>/dev/null || true

# ── 2. Build UAT runner image (Rocky Linux 9 + Docker CLI) ───
log "Building UAT runner image: ${UAT_IMAGE} ..."
docker build ${NO_CACHE} \
    -f "${PROJECT_ROOT}/Dockerfile.uat-cron" \
    -t "${UAT_IMAGE}" \
    "${PROJECT_ROOT}" \
    2>&1 | grep -E "^(#[0-9]+ |\[|Step|Error|error)" | head -60 || true
ok "UAT image ready: ${UAT_IMAGE}"

# ── 3. Build Cronicle UAT image (Cronicle + mock runners) ────
log "Building Cronicle UAT image: ${CRONICLE_IMAGE} ..."
docker build ${NO_CACHE} \
    -f "${PROJECT_ROOT}/Dockerfile.cronicle-uat" \
    -t "${CRONICLE_IMAGE}" \
    "${PROJECT_ROOT}" \
    2>&1 | grep -E "^(#[0-9]+ |\[|Step|Error|error)" | head -60 || true
ok "Cronicle image ready: ${CRONICLE_IMAGE}"

# ── 4. Create shared Docker network ──────────────────────────
log "Creating Docker network: ${UAT_NETWORK} ..."
docker network create "${UAT_NETWORK}" &>/dev/null
ok "Network created: ${UAT_NETWORK}"

# ── 5. Derive API key ─────────────────────────────────────────
CRONICLE_API_KEY=""
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    CRONICLE_API_KEY=$(grep -E '^CRONICLE_API_KEY=' "${PROJECT_ROOT}/.env" \
                       | cut -d= -f2- | tr -d '"' | tr -d "'" 2>/dev/null || true)
fi
if [[ -z "$CRONICLE_API_KEY" ]]; then
    CRONICLE_API_KEY=$(openssl rand -hex 16)
    log "Generated CRONICLE_API_KEY: ${CRONICLE_API_KEY:0:8}..."
else
    log "Using CRONICLE_API_KEY from .env: ${CRONICLE_API_KEY:0:8}..."
fi

echo ""
log "Starting UAT container (Rocky Linux 9) ..."
log "  UAT image:       ${UAT_IMAGE}"
log "  Cronicle image:  ${CRONICLE_IMAGE}"
log "  Network:         ${UAT_NETWORK}"
log "  Cronicle name:   ${CRONICLE_CONTAINER}"
log "  API Key:         ${CRONICLE_API_KEY:0:8}..."
echo ""

# ── 6. Run UAT container ─────────────────────────────────────
# The container:
#   - mounts the host Docker socket (to start Cronicle as sibling)
#   - is placed on uat-cron-net (to reach Cronicle by container name)
#   - clones opendog from GitHub and runs all 27 test cases
REMOVE_FLAG="--rm"
[[ "$KEEP" == true ]] && REMOVE_FLAG=""

docker run \
    ${REMOVE_FLAG} \
    --name  "${UAT_CONTAINER}" \
    --network "${UAT_NETWORK}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e OPENDOG_REPO="https://github.com/VincentHanxiaoDu/opendog.git" \
    -e CRONICLE_API_KEY="${CRONICLE_API_KEY}" \
    -e CRONICLE_PORT="3012" \
    -e CRONICLE_CONTAINER="${CRONICLE_CONTAINER}" \
    -e CRONICLE_IMAGE="${CRONICLE_IMAGE}" \
    -e UAT_NETWORK="${UAT_NETWORK}" \
    -e CRONICLE_ADMIN_PASSWORD="admin" \
    -e COMPOSE_WAIT_MAX="180" \
    "${UAT_IMAGE}"

EXIT_CODE=$?
echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
    ok "UAT PASSED (exit 0)"
else
    err "UAT FAILED (exit ${EXIT_CODE})"
    if [[ "$KEEP" == true ]]; then
        log "Container '${UAT_CONTAINER}' preserved. Debug with:"
        log "  docker exec -it ${UAT_CONTAINER} bash"
        log "  docker logs ${CRONICLE_CONTAINER}"
    fi
    exit $EXIT_CODE
fi
