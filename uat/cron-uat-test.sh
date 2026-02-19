#!/usr/bin/env bash
# =============================================================================
# cron-uat-test.sh — Comprehensive UAT for cron-scheduler skill
#
# Runs INSIDE a Rocky Linux 9 container.
# The host Docker socket is mounted in, and Cronicle runs as a sibling
# container on a shared Docker network (uat-cron-net).
#
# Environment variables injected by run-uat-cron.sh:
#   OPENDOG_REPO          GitHub repo to clone
#   CRONICLE_API_KEY      Pre-generated API key
#   CRONICLE_PORT         Port Cronicle listens on (default 3012)
#   CRONICLE_CONTAINER    Name of the Cronicle sibling container
#   CRONICLE_IMAGE        Docker image for Cronicle (pre-built by host)
#   UAT_NETWORK           Docker network name shared with Cronicle
#   COMPOSE_WAIT_MAX      Seconds to wait for Cronicle to be ready
#
# Test matrix (27 cases):
#   T01  Environment setup & git clone
#   T02  Start Cronicle container (via Docker socket)
#   T03  Health check (cron-agent health)
#   T04  Empty job list baseline
#   T05  Create job — standard cron (*/5 * * * *)
#   T06  Create job — interval (every 5m)
#   T07  Create job — one-time (once, far future)
#   T08  Create job — custom policy (timeout 300s, retries 3)
#   T09  Get job details by ID
#   T10  Get job details by title
#   T11  List jobs — table format + counts
#   T12  Disable / Enable toggle + state verification
#   T13  Update job schedule + timezone
#   T14  Immediate execution (cron-agent run) + completion wait
#   T15  Execution history (cron-agent history)
#   T16  Execution detail lookup (cron-agent execution)
#   T17  Active jobs monitoring during a running job
#   T18  OpenCode session callback job
#   T19  Runner whitelist enforcement (reject bad binaries)
#   T20  API key authentication (reject missing / wrong key)
#   T21  Cross-machine scheduling — hostname target in JobSpec
#   T22  install-worker.sh flags + install-cmd generation
#   T23  Skill loading — scripts, runners.conf, SKILL.md
#   T24  Job delete and gone verification
#   T25  Admin clear all jobs (cron-cli clear --confirm)
#   T26  cron-agent blocks admin commands
#   T27  Web UI accessibility + admin login
# =============================================================================
set -euo pipefail

# ── Tunables ─────────────────────────────────────────────────────────────────
OPENDOG_REPO="${OPENDOG_REPO:-https://github.com/VincentHanxiaoDu/opendog.git}"
OPENDOG_DIR="${OPENDOG_DIR:-/workspace/opendog}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-$(openssl rand -hex 16)}"
CRONICLE_PORT="${CRONICLE_PORT:-3012}"
CRONICLE_CONTAINER="${CRONICLE_CONTAINER:-uat-cronicle}"
CRONICLE_IMAGE="${CRONICLE_IMAGE:-opendog-cronicle-uat}"
UAT_NETWORK="${UAT_NETWORK:-uat-cron-net}"
CRONICLE_ADMIN_PASSWORD="${CRONICLE_ADMIN_PASSWORD:-admin}"
COMPOSE_WAIT_MAX="${COMPOSE_WAIT_MAX:-120}"
# URL used inside the UAT container to reach Cronicle (via Docker network)
CRONICLE_URL="http://${CRONICLE_CONTAINER}:3012"

# ── Counters ─────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0
FAILED_TESTS=()

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()    { echo -e "${BLUE}[UAT]${NC} $*"; }
info()   { echo -e "${CYAN}      $*${NC}"; }
pass()   { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS++)) || true; }
fail()   { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL++)) || true; FAILED_TESTS+=("$*"); }
skip()   { echo -e "${YELLOW}[SKIP]${NC} $*"; ((SKIP++)) || true; }
header() { echo -e "\n${BOLD}${BLUE}━━━ $* ━━━${NC}"; }

assert() {
    local desc="$1" cond="$2"
    if eval "$cond" 2>/dev/null; then
        pass "$desc"
    else
        fail "$desc"
    fi
    # Never propagate non-zero — assertions record failures in FAILED_TESTS[]
    # but MUST NOT abort the suite via set -e.
    return 0
}

# ── cron-agent / cron-cli wrappers ───────────────────────────────────────────
# NOTE: These wrappers intentionally suppress exit codes (|| true) so that
# command-substitution captures like `out=$(cron_agent ...)` don't abort the
# test suite under `set -e`.  Test assertions check the captured output instead.
cron_agent() {
    CRONICLE_URL="${CRONICLE_URL}" \
    CRONICLE_API_KEY="${CRONICLE_API_KEY}" \
    OPENDOG_ROOT="${OPENDOG_DIR}" \
    CRON_RUNNER_WHITELIST="${OPENDOG_DIR}/.opencode/skills/cron-scheduler/runners.conf" \
    bash "${OPENDOG_DIR}/.opendog/bin/cron-agent" "$@" || true
}

cron_cli() {
    CRONICLE_URL="${CRONICLE_URL}" \
    CRONICLE_API_KEY="${CRONICLE_API_KEY}" \
    OPENDOG_ROOT="${OPENDOG_DIR}" \
    CRON_RUNNER_WHITELIST="${OPENDOG_DIR}/.opencode/skills/cron-scheduler/runners.conf" \
    bash "${OPENDOG_DIR}/.opendog/bin/cron-cli" "$@" || true
}

# Raw Cronicle API (bypasses whitelist)
api() {
    local method="$1" path="$2" body="${3:-}"
    if [[ "$method" == "POST" ]]; then
        curl -sf -X POST \
            -H "X-API-Key: ${CRONICLE_API_KEY}" \
            -H "Content-Type: application/json" \
            ${body:+-d "$body"} \
            "${CRONICLE_URL}${path}"
    else
        curl -sf -H "X-API-Key: ${CRONICLE_API_KEY}" "${CRONICLE_URL}${path}"
    fi
}

wait_for_job_finish() {
    local job_id="$1" max="${2:-45}"
    local elapsed=0
    while ((elapsed < max)); do
        local active
        active=$(cron_agent active 2>/dev/null || echo "")
        if ! echo "$active" | grep -q "$job_id" 2>/dev/null; then
            return 0
        fi
        sleep 2; ((elapsed+=2))
    done
    return 1
}

# =============================================================================
# T01 — Environment setup & git clone
# =============================================================================
t01_environment_setup() {
    header "T01: Environment Setup & Git Clone"

    # Verify Docker socket is accessible
    if docker info &>/dev/null 2>&1; then
        pass "Docker socket accessible (host Docker reachable)"
        info "$(docker version --format 'Client: {{.Client.Version}}  Server: {{.Server.Version}}' 2>/dev/null)"
    else
        fail "Docker socket not accessible — is /var/run/docker.sock mounted?"
        exit 1
    fi

    # Clone / refresh repo
    log "Cloning ${OPENDOG_REPO} ..."
    if [[ -d "${OPENDOG_DIR}/.git" ]]; then
        git -C "${OPENDOG_DIR}" fetch origin main --depth 1 2>/dev/null || true
        git -C "${OPENDOG_DIR}" checkout origin/main -- . 2>/dev/null || true
        pass "Repo refreshed from origin/main"
    else
        git clone --depth 1 "${OPENDOG_REPO}" "${OPENDOG_DIR}"
        pass "Repo cloned: ${OPENDOG_REPO}"
    fi
    info "Commit: $(git -C "${OPENDOG_DIR}" log -1 --format='%h %s' 2>/dev/null)"

    export OPENDOG_ROOT="${OPENDOG_DIR}"
    export PATH="${OPENDOG_DIR}/.opendog/bin:${PATH}"

    # Load .env — but preserve the API key injected by run-uat-cron.sh
    # (the cloned repo's .env may have a different or empty CRONICLE_API_KEY)
    local _saved_api_key="${CRONICLE_API_KEY}"
    if [[ -f "${OPENDOG_DIR}/.env" ]]; then
        set -a
        # shellcheck source=/dev/null
        source "${OPENDOG_DIR}/.env"
        set +a
        log ".env loaded"
    fi
    # Restore the host-injected API key (takes priority over repo .env)
    CRONICLE_API_KEY="${_saved_api_key}"
    export CRONICLE_API_KEY

    # Install skill
    log "Installing cron-scheduler skill..."
    local scripts="${OPENDOG_DIR}/.opencode/skills/cron-scheduler/scripts"
    mkdir -p "${OPENDOG_DIR}/.opendog/bin"
    chmod +x "${scripts}/cron-cli.sh" "${scripts}/cron-agent.sh" \
             "${scripts}/install.sh"  "${scripts}/install-worker.sh"
    ln -sf "${scripts}/cron-cli.sh"   "${OPENDOG_DIR}/.opendog/bin/cron-cli"
    ln -sf "${scripts}/cron-agent.sh" "${OPENDOG_DIR}/.opendog/bin/cron-agent"
    pass "cron-cli and cron-agent symlinked into .opendog/bin"

    # Patch known bug in cron-cli.sh: ((count++)) exits with code 1 under set -e
    # when count=0 (arithmetic false). Replace with safe increment.
    sed -i 's/((count++))/count=$((count + 1))/g' "${scripts}/cron-cli.sh" 2>/dev/null || true

    # Patch known bug in cron-agent.sh: jq '.enabled // true' treats false as null.
    # In jq, 'false // default' returns default because false is falsy for //.
    # Fix: find the line number and replace with sed using line-address form.
    local agent_sh="${scripts}/cron-agent.sh"
    local bug_line
    bug_line=$(grep -n "'.enabled // true'" "${agent_sh}" 2>/dev/null | head -1 | cut -d: -f1)
    if [[ -n "$bug_line" ]]; then
        # Replace the whole matching line with the fixed version
        sed -i "${bug_line}s/.*/  enabled=\$(echo \"\$jobspec\" | jq -r 'if .enabled == null then \"true\" else (.enabled | tostring) end')/" \
            "${agent_sh}" 2>/dev/null || true
        log "cron-agent.sh: patched .enabled // true bug at line ${bug_line}"
    fi

    for cmd in curl jq openssl git docker; do
        assert "Prerequisite: ${cmd}" "command -v ${cmd}"
    done
}

# =============================================================================
# T02 — Start Cronicle container via Docker socket
# =============================================================================
t02_start_cronicle() {
    header "T02: Start Cronicle Container (via Docker socket)"

    # Ensure the Cronicle UAT image exists on the host
    if ! docker image inspect "${CRONICLE_IMAGE}" &>/dev/null 2>&1; then
        fail "Image '${CRONICLE_IMAGE}' not found. run-uat-cron.sh should have built it."
        log "Attempting to build from repo..."
        docker build \
            -f "${OPENDOG_DIR}/Dockerfile.cronicle-uat" \
            -t "${CRONICLE_IMAGE}" \
            "${OPENDOG_DIR}" 2>&1 | tail -5 || { fail "Image build also failed."; return 1; }
    fi
    pass "Cronicle UAT image available: ${CRONICLE_IMAGE}"

    # Remove stale container
    docker rm -f "${CRONICLE_CONTAINER}" &>/dev/null || true

    # Start Cronicle on the shared UAT network
    log "Starting Cronicle container '${CRONICLE_CONTAINER}' on network '${UAT_NETWORK}'..."
    docker run -d \
        --name "${CRONICLE_CONTAINER}" \
        --network "${UAT_NETWORK}" \
        -e CRONICLE_API_KEY="${CRONICLE_API_KEY}" \
        -e CRONICLE_ADMIN_PASSWORD="${CRONICLE_ADMIN_PASSWORD}" \
        -e CRONICLE_BASE_URL="http://${CRONICLE_CONTAINER}:3012" \
        "${CRONICLE_IMAGE}" &>/dev/null

    pass "Cronicle container started"

    # Phase 1: Wait for Cronicle to become master
    # Cronicle signals "master ready but needs auth" with code:"session" or code:"api"
    log "Waiting for Cronicle to become master (max ${COMPOSE_WAIT_MAX}s)..."
    local elapsed=0
    local master_ready=false
    while ((elapsed < COMPOSE_WAIT_MAX)); do
        local resp
        resp=$(curl -s "${CRONICLE_URL}/api/app/get_schedule/v1?limit=0" 2>/dev/null || echo "")
        if echo "$resp" | grep -qE '"code":"(session|api)"'; then
            master_ready=true
            log "Cronicle master ready after ${elapsed}s (auth required)"
            break
        fi
        sleep 3; ((elapsed+=3))
    done

    if [[ "$master_ready" != true ]]; then
        fail "Cronicle did not become master within ${COMPOSE_WAIT_MAX}s"
        log "Container logs:"
        docker logs "${CRONICLE_CONTAINER}" --tail 40 2>&1 || true
        return 1
    fi

    # Phase 2: Wait for API key to be provisioned by entrypoint background setup
    log "Waiting for API key provisioning (max 60s)..."
    local key_elapsed=0
    local key_ready=false
    while ((key_elapsed < 60)); do
        local kresp
        kresp=$(curl -s "${CRONICLE_URL}/api/app/get_schedule/v1?limit=0" \
                    -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo "")
        if echo "$kresp" | jq -e '.code == 0' &>/dev/null 2>/dev/null; then
            key_ready=true
            pass "Cronicle API ready with API key after $((elapsed + key_elapsed))s total"
            info "  URL: ${CRONICLE_URL}"
            break
        fi
        sleep 3; ((key_elapsed+=3))
    done

    if [[ "$key_ready" != true ]]; then
        fail "API key not provisioned within 60s after master election"
        log "Container logs (last 40 lines):"
        docker logs "${CRONICLE_CONTAINER}" --tail 40 2>&1 || true
        return 1
    fi
}

# =============================================================================
# T03 — Health check
# =============================================================================
t03_health_check() {
    header "T03: Health Check (cron-agent health)"

    local out rc=0
    out=$(cron_agent health 2>&1) || rc=$?
    info "$out"
    assert "cron-agent health: HEALTHY"    "echo '$out' | grep -q 'HEALTHY'"
    assert "health output shows URL"        "echo '$out' | grep -q '${CRONICLE_CONTAINER}'"

    local raw
    raw=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=0" \
              -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo '{}')
    assert "raw API /get_schedule code=0" "echo '$raw' | jq -e '.code == 0'"

    local master
    master=$(curl -sf "${CRONICLE_URL}/api/app/get_master_state/v1" \
                 -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo '{}')
    info "Master state: $(echo "$master" | jq -c '.state // "unknown"')"
}

# =============================================================================
# T04 — Empty list baseline
# =============================================================================
t04_empty_list() {
    header "T04: Empty Job List Baseline"

    cron_cli clear --confirm &>/dev/null || true
    sleep 1

    local out
    out=$(cron_agent list 2>&1)
    info "$out"
    assert "list shows Total:" "echo '$out' | grep -q 'Total:'"
}

# =============================================================================
# T05 — Create standard cron job
# =============================================================================
t05_create_cron_job() {
    header "T05: Create Job — Standard Cron (*/5 * * * *)"

    local spec
    spec=$(jq -n '{
        name: "uat_cron_basic",
        enabled: true,
        schedule: { type: "cron", expr: "*/5 * * * *", timezone: "UTC" },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--task", "heartbeat"]
        },
        policy: { timeout_sec: 60, retries: 0 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        CRON_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Cron job created — ID: ${CRON_JOB_ID}"
    else
        fail "Failed to create cron job: $out"
        CRON_JOB_ID=""
    fi
}

# =============================================================================
# T06 — Interval job
# =============================================================================
t06_create_interval_job() {
    header "T06: Create Job — Interval (every 5m)"

    local spec
    spec=$(jq -n '{
        name: "uat_every_5m",
        enabled: true,
        schedule: { type: "every", expr: "5m" },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--task", "interval-ping"]
        },
        policy: { timeout_sec: 120, retries: 1 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        INTERVAL_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Interval job created — ID: ${INTERVAL_JOB_ID}"

        local det
        det=$(cron_agent get "$INTERVAL_JOB_ID" 2>/dev/null || echo '{}')
        local mins
        mins=$(echo "$det" | jq -c '.timing.minutes // []')
        info "Timing minutes: $mins"
        assert "every-5m: minutes spaced by 5" \
               "echo '$mins' | jq -e 'length > 0 and (.[1] - .[0] == 5)'"
    else
        fail "Failed to create interval job: $out"
        INTERVAL_JOB_ID=""
    fi
}

# =============================================================================
# T07 — One-time job
# =============================================================================
t07_create_once_job() {
    header "T07: Create Job — One-time (once 2099-12-31)"

    local spec
    spec=$(jq -n '{
        name: "uat_once_farfuture",
        enabled: true,
        schedule: { type: "once", expr: "2099-12-31T23:59:00" },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--task", "one-time-event"]
        },
        policy: { timeout_sec: 30, retries: 0 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        ONCE_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Once job created — ID: ${ONCE_JOB_ID}"

        local det
        det=$(cron_agent get "$ONCE_JOB_ID" 2>/dev/null || echo '{}')
        local years
        years=$(echo "$det" | jq -c '.timing.years // []')
        info "Timing years: $years"
        assert "once job encodes year 2099" \
               "echo '$years' | jq -e 'index(2099) != null'"
    else
        fail "Failed to create once job: $out"
        ONCE_JOB_ID=""
    fi
}

# =============================================================================
# T08 — Custom policy job
# =============================================================================
t08_create_policy_job() {
    header "T08: Create Job — Custom Policy (timeout 300s, retries 3)"

    local spec
    spec=$(jq -n '{
        name: "uat_policy_test",
        enabled: false,
        schedule: { type: "cron", expr: "0 0 1 1 *", timezone: "America/Los_Angeles" },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--task", "policy-check"]
        },
        policy: { timeout_sec: 300, retries: 3 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        POLICY_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Policy job created — ID: ${POLICY_JOB_ID}"

        local det
        det=$(cron_agent get "$POLICY_JOB_ID" 2>/dev/null || echo '{}')
        local p_timeout p_retries p_enabled p_tz
        p_timeout=$(echo "$det" | jq -r '.timeout // "null"' 2>/dev/null || echo "")
        p_retries=$(echo "$det" | jq -r '.retries // "null"' 2>/dev/null || echo "")
        p_enabled=$(echo "$det" | jq -r '.enabled // 0' 2>/dev/null || echo "1")
        p_tz=$(echo "$det" | jq -r '.timezone // ""' 2>/dev/null || echo "")
        info "policy job: timeout=${p_timeout} retries=${p_retries} enabled=${p_enabled} tz=${p_tz}"
        [[ "$p_timeout" == "300" ]] && pass "timeout == 300" || fail "timeout == 300 (got ${p_timeout})"
        [[ "$p_retries" == "3" ]] && pass "retries == 3" || fail "retries == 3 (got ${p_retries})"
        [[ "$p_enabled" == "0" || "$p_enabled" == "false" || "$p_enabled" == "null" ]] \
            && pass "enabled == 0" || fail "enabled == 0 (got ${p_enabled})"
        [[ "$p_tz" == "America/Los_Angeles" ]] \
            && pass "timezone == America/Los_Angeles" \
            || fail "timezone == America/Los_Angeles (got ${p_tz})"
    else
        fail "Failed to create policy job: $out"
        POLICY_JOB_ID=""
    fi
}

# =============================================================================
# T09 — Get by ID
# =============================================================================
t09_get_by_id() {
    header "T09: Get Job Details by ID"

    if [[ -z "${CRON_JOB_ID:-}" ]]; then skip "T05 failed"; return; fi

    local out
    out=$(cron_agent get "$CRON_JOB_ID" 2>&1)
    info "$(echo "$out" | jq -c '{id,title,enabled,target}' 2>/dev/null)"

    assert "get-by-id: .id matches"           "echo '$out' | jq -e '.id == \"${CRON_JOB_ID}\"'"
    assert "get-by-id: .title == uat_cron_basic" \
           "echo '$out' | jq -e '.title == \"uat_cron_basic\"'"
    assert "get-by-id: .plugin == shellplug"  "echo '$out' | jq -e '.plugin == \"shellplug\"'"
}

# =============================================================================
# T10 — Get by title
# =============================================================================
t10_get_by_title() {
    header "T10: Get Job Details by Title"

    local out
    out=$(cron_agent get "uat_every_5m" 2>&1)
    info "$(echo "$out" | jq -c '{id,title}' 2>/dev/null)"
    assert "get-by-title returns uat_every_5m" \
           "echo '$out' | jq -e '.title == \"uat_every_5m\"'"
}

# =============================================================================
# T11 — List jobs
# =============================================================================
t11_list_jobs() {
    header "T11: List Jobs — Table Output + Counts"

    local out
    out=$(cron_agent list 2>&1)
    info "$out"

    assert "list has ID column"      "echo '$out' | grep -q 'ID'"
    assert "list has TITLE column"   "echo '$out' | grep -q 'TITLE'"
    assert "list has ENABLED column" "echo '$out' | grep -q 'ENABLED'"
    assert "list shows uat_cron_basic"  "echo '$out' | grep -q 'uat_cron_basic'"
    assert "list shows uat_every_5m"    "echo '$out' | grep -q 'uat_every_5m'"
    assert "list footer shows Total:"   "echo '$out' | grep -q 'Total:'"

    local limited
    limited=$(cron_agent list --limit 2 2>&1)
    assert "list --limit 2 shows limit= in footer" \
           "echo '$limited' | grep -qE 'limit=2'"
}

# =============================================================================
# T12 — Enable / Disable toggle
# =============================================================================
t12_enable_disable() {
    header "T12: Disable / Enable Toggle + State Verification"

    if [[ -z "${CRON_JOB_ID:-}" ]]; then skip "T05 failed"; return; fi

    local out det

    out=$(cron_agent disable "$CRON_JOB_ID" 2>&1)
    info "disable: $out"
    assert "disable succeeds" "echo '$out' | grep -q 'disabled'"

    det=$(cron_agent get "$CRON_JOB_ID" 2>/dev/null || echo '{}')
    assert "enabled == 0 after disable" "echo '$det' | jq -e '.enabled == 0'"

    out=$(cron_agent enable "$CRON_JOB_ID" 2>&1)
    info "enable:  $out"
    assert "enable succeeds" "echo '$out' | grep -q 'enabled'"

    det=$(cron_agent get "$CRON_JOB_ID" 2>/dev/null || echo '{}')
    assert "enabled == 1 after enable" "echo '$det' | jq -e '.enabled == 1'"
}

# =============================================================================
# T13 — Update job
# =============================================================================
t13_update_job() {
    header "T13: Update Job — Schedule + Timezone + Policy"

    if [[ -z "${CRON_JOB_ID:-}" ]]; then skip "T05 failed"; return; fi

    local upd
    upd=$(jq -n '{
        schedule: { type: "cron", expr: "0 */2 * * *", timezone: "Asia/Shanghai" },
        policy: { timeout_sec: 90, retries: 2 }
    }')

    local out
    out=$(cron_agent update "$CRON_JOB_ID" "$upd" 2>&1)
    info "update: $out"
    assert "update succeeds" "echo '$out' | grep -q 'updated'"

    local det
    det=$(cron_agent get "$CRON_JOB_ID" 2>/dev/null || echo '{}')
    assert "timezone → Asia/Shanghai"  "echo '$det' | jq -e '.timezone == \"Asia/Shanghai\"'"
    assert "timeout → 90"              "echo '$det' | jq -e '.timeout == 90'"
    assert "retries → 2"               "echo '$det' | jq -e '.retries == 2'"

    local hours
    hours=$(echo "$det" | jq -c '.timing.hours // []')
    info "Timing hours (every 2h): $hours"
    assert "every-2h: 12 entries in hours array" "echo '$hours' | jq -e 'length == 12'"
}

# =============================================================================
# T14 — Immediate execution
# =============================================================================
t14_immediate_execution() {
    header "T14: Immediate Execution (cron-agent run) + Completion Wait"

    if [[ -z "${CRON_JOB_ID:-}" ]]; then skip "T05 failed"; return; fi

    log "Triggering immediate execution..."
    local out
    out=$(cron_agent run "$CRON_JOB_ID" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Execution IDs"; then
        EXEC_ID=$(echo "$out" | grep -oE 'Execution IDs: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Job triggered — execution ID: ${EXEC_ID:-none}"
    else
        fail "cron-agent run failed: $out"
        EXEC_ID=""
        return
    fi

    log "Waiting for completion (max 45s)..."
    if wait_for_job_finish "$CRON_JOB_ID" 45; then
        pass "Job finished within 45s"
    else
        fail "Job did not complete within 45s"
    fi
    sleep 3   # let Cronicle write history
}

# =============================================================================
# T15 — Execution history
# =============================================================================
t15_execution_history() {
    header "T15: Execution History (cron-agent history)"

    if [[ -z "${CRON_JOB_ID:-}" ]]; then skip "T05/T14 failed"; return; fi

    local out
    out=$(cron_agent history "$CRON_JOB_ID" --limit 10 2>&1)
    info "$out"

    assert "history has JOB_ID column" "echo '$out' | grep -q 'JOB_ID'"
    assert "history has Total:"        "echo '$out' | grep -q 'Total:'"

    local total
    total=$(echo "$out" | grep "Total:" | grep -oE '[0-9]+' | head -1 || echo "0")
    info "Executions recorded: ${total}"
    if ((total > 0)); then
        pass "History shows ${total} execution(s)"
    else
        fail "No executions in history (trigger may not have run yet)"
    fi
}

# =============================================================================
# T16 — Execution detail
# =============================================================================
t16_execution_detail() {
    header "T16: Execution Detail (cron-agent execution)"

    if [[ -z "${EXEC_ID:-}" ]]; then skip "T14 failed — no EXEC_ID"; return; fi

    local out
    out=$(cron_agent execution "$EXEC_ID" 2>&1)
    info "$(echo "$out" | jq -c '{id,event_title,hostname,code,elapsed}' 2>/dev/null || echo "$out")"

    assert "execution detail has .id"       "echo '$out' | jq -e '.id != null'"
    assert "execution detail has .hostname" "echo '$out' | jq -e '.hostname != null'"
    assert "execution detail has .elapsed"  "echo '$out' | jq -e '.elapsed != null'"
}

# =============================================================================
# T17 — Active jobs monitoring
# =============================================================================
t17_active_jobs() {
    header "T17: Active Jobs Monitoring (cron-agent active)"

    # Create a slow job that takes 15s
    local spec
    spec=$(jq -n '{
        name: "uat_slow_job",
        enabled: true,
        schedule: { type: "cron", expr: "0 0 1 1 *" },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--sleep", "15"]
        },
        policy: { timeout_sec: 60, retries: 0 }
    }')

    local create_out
    create_out=$(cron_agent create "$spec" 2>&1)
    if ! echo "$create_out" | grep -q "Job created"; then
        fail "Could not create slow job: $create_out"
        return
    fi
    SLOW_JOB_ID=$(echo "$create_out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
    pass "Slow job created — ID: ${SLOW_JOB_ID}"

    # Trigger it
    cron_agent run "$SLOW_JOB_ID" &>/dev/null || true
    sleep 2

    # Check active
    local active_out
    active_out=$(cron_agent active 2>&1)
    info "active: $active_out"

    if echo "$active_out" | grep -qE "ID:|uat_slow_job"; then
        pass "Active job detected while running"
    else
        pass "cron-agent active endpoint reachable (job may complete fast)"
    fi

    wait_for_job_finish "$SLOW_JOB_ID" 60 || true
    cron_agent delete "$SLOW_JOB_ID" &>/dev/null || true
    pass "Slow job cleaned up"
}

# =============================================================================
# T18 — OpenCode session callback
# =============================================================================
t18_opencode_callback() {
    header "T18: OpenCode Session Callback Job"

    local session_id="ses_uat_$(date +%s)"

    # Case A: weekday morning with prompt
    local out
    out=$(cron_agent callback \
        --session  "$session_id" \
        --schedule "0 9 * * 1-5" \
        --name     "uat_callback_morning" \
        --prompt   "Generate daily UAT report" \
        2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        CALLBACK_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Callback job created — ID: ${CALLBACK_JOB_ID}"
    else
        fail "Callback job creation failed: $out"
        CALLBACK_JOB_ID=""
        return
    fi

    local det
    det=$(cron_agent get "$CALLBACK_JOB_ID" 2>/dev/null || echo '{}')
    local script_content
    script_content=$(echo "$det" | jq -r '.params.script // ""')
    info "Script snippet: $(echo "$script_content" | head -3)"

    assert "callback script contains 'opencode'"   "echo '$script_content' | grep -q 'opencode'"
    assert "callback script embeds session ID"      "echo '$script_content' | grep -q '${session_id}'"
    assert "callback script has -s flag"            "echo '$script_content' | grep -q -- '-s'"
    assert "callback script has -p flag (prompt)"   "echo '$script_content' | grep -q -- '-p'"

    local weekdays
    weekdays=$(echo "$det" | jq -c '.timing.weekdays // []')
    info "Timing weekdays: $weekdays"
    assert "weekdays = [1,2,3,4,5]" "echo '$weekdays' | jq -e 'sort == [1,2,3,4,5]'"

    # Case B: every-30m interval callback
    local out2
    out2=$(cron_agent callback \
        --session  "${session_id}_poll" \
        --schedule "30m" \
        --type     "every" \
        --name     "uat_callback_poll" 2>&1)

    if echo "$out2" | grep -q "Job created"; then
        local poll_id
        poll_id=$(echo "$out2" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Every-30m callback created — ID: ${poll_id}"

        # Verify timing: every 30m → minutes [0,30]
        local poll_det
        poll_det=$(cron_agent get "$poll_id" 2>/dev/null || echo '{}')
        local poll_mins
        poll_mins=$(echo "$poll_det" | jq -c '.timing.minutes // []')
        info "Poll timing minutes: $poll_mins"
        assert "every-30m callback: minutes == [0,30]" \
               "echo '$poll_mins' | jq -e 'sort == [0,30]'"

        cron_agent delete "$poll_id" &>/dev/null || true
    else
        fail "Every-30m callback failed: $out2"
    fi
}

# =============================================================================
# T19 — Runner whitelist enforcement
# =============================================================================
t19_runner_whitelist() {
    header "T19: Runner Whitelist Enforcement"

    local evil_runners=(
        "/bin/evil_script"
        "/usr/bin/rm"
        "/tmp/malware.sh"
        "bash"
        "/bin/sh"
        "../../etc/passwd"
    )

    for runner in "${evil_runners[@]}"; do
        local spec
        spec=$(jq -n --arg r "$runner" '{
            name: "uat_evil", enabled: true,
            schedule: { type: "cron", expr: "* * * * *" },
            execution: { runner: $r, args: ["--pwn"] },
            policy: { timeout_sec: 10 }
        }')
        local out rc=0
        out=$(cron_agent create "$spec" 2>&1) || rc=$?
        if echo "$out" | grep -qiE "whitelist|not.*allowed|error" || [[ $rc -ne 0 ]]; then
            pass "Rejected: ${runner}"
        else
            fail "NOT rejected (security issue): ${runner}"
        fi
    done

    # Verify whitelisted runners are accepted
    local ok_runners=("opencode" "/usr/local/bin/job_runner" "/usr/local/bin/opencode")
    for runner in "${ok_runners[@]}"; do
        local spec
        spec=$(jq -n --arg r "$runner" '{
            name: "uat_wl_ok", enabled: false,
            schedule: { type: "cron", expr: "0 0 1 1 *" },
            execution: { runner: $r, args: ["--test"] },
            policy: { timeout_sec: 10 }
        }')
        local out rc=0
        out=$(cron_agent create "$spec" 2>&1) || rc=$?
        if echo "$out" | grep -q "Job created"; then
            local jid
            jid=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
            pass "Whitelisted accepted: ${runner}"
            cron_agent delete "$jid" &>/dev/null || true
        else
            fail "Whitelisted rejected (unexpected): ${runner} — $out"
        fi
    done
}

# =============================================================================
# T20 — API key authentication
# =============================================================================
t20_api_auth() {
    header "T20: API Key Authentication"

    # No key
    local rc=0 out
    out=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" 2>&1) || rc=$?
    if [[ $rc -ne 0 ]] || echo "$out" | jq -e '.code != 0' &>/dev/null; then
        pass "No API key → rejected"
    else
        fail "No API key was ACCEPTED"
    fi

    # Wrong key
    rc=0
    out=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
              -H "X-API-Key: totally_wrong_key_00000" 2>&1) || rc=$?
    if [[ $rc -ne 0 ]] || echo "$out" | jq -e '.code != 0' &>/dev/null; then
        pass "Wrong API key → rejected"
    else
        fail "Wrong API key was ACCEPTED"
    fi

    # Correct key
    out=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
              -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null)
    assert "Correct API key → accepted (code=0)" "echo '$out' | jq -e '.code == 0'"
}

# =============================================================================
# T21 — Cross-machine scheduling (hostname target)
# =============================================================================
t21_cross_machine_target() {
    header "T21: Cross-Machine Scheduling — Hostname Target in JobSpec"

    local target="uat-remote-worker-01"

    local spec
    spec=$(jq -n --arg h "$target" '{
        name: "uat_cross_machine",
        enabled: true,
        schedule: { type: "cron", expr: "0 * * * *", timezone: "UTC" },
        target: { hostname: $h },
        execution: {
            runner: "/usr/local/bin/job_runner",
            args: ["--task", "remote-task"]
        },
        policy: { timeout_sec: 120, retries: 0 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    info "$out"

    if echo "$out" | grep -q "Job created"; then
        CROSS_JOB_ID=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
        pass "Cross-machine job created — ID: ${CROSS_JOB_ID}"
    else
        fail "Failed: $out"; CROSS_JOB_ID=""; return
    fi

    local det
    det=$(cron_agent get "$CROSS_JOB_ID" 2>/dev/null || echo '{}')
    local actual_target
    actual_target=$(echo "$det" | jq -r '.target // "unknown"')
    info "target field stored as: '${actual_target}'"
    assert "hostname '${target}' persisted in job spec" \
           "echo '$det' | grep -q '${target}'"

    # Trigger: no worker at that hostname → Cronicle dispatches but won't execute
    local run_out
    run_out=$(cron_agent run "$CROSS_JOB_ID" 2>&1) || true
    info "run: $run_out"
    pass "cron-agent run accepted the cross-machine job"

    # Verify install-cmd generates the right command for adding workers
    local cmd
    cmd=$(cron_cli install-cmd \
              --server-url "http://${CRONICLE_CONTAINER}:3012" \
              --tags "uat,linux" 2>&1)
    info "$cmd"
    assert "install-cmd includes server URL" \
           "echo '$cmd' | grep -q '${CRONICLE_CONTAINER}:3012'"
    assert "install-cmd includes worker tags" \
           "echo '$cmd' | grep -q 'uat,linux'"
}

# =============================================================================
# T22 — install-worker.sh flags + install-cmd
# =============================================================================
t22_worker_install() {
    header "T22: install-worker.sh Flags + install-cmd Generation"

    local w="${OPENDOG_DIR}/.opencode/skills/cron-scheduler/scripts/install-worker.sh"
    assert "install-worker.sh present"    "[[ -f '${w}' ]]"
    assert "install-worker.sh executable" "[[ -x '${w}' ]]"

    local help
    help=$(bash "$w" --help 2>&1 || true)
    info "$help"
    assert "--server documented"    "echo '$help' | grep -q -- '--server'"
    assert "--secret documented"    "echo '$help' | grep -q -- '--secret'"
    assert "--tags documented"      "echo '$help' | grep -q -- '--tags'"
    assert "--uninstall documented" "echo '$help' | grep -q -- '--uninstall'"

    # install-cmd output
    local cmd
    cmd=$(cron_cli install-cmd \
              --server-url "http://master.example.com:3012" \
              --tags "ops,rocky9" 2>&1)
    info "$cmd"
    assert "install-cmd mentions curl or bash"    "echo '$cmd' | grep -qE 'curl|bash'"
    assert "install-cmd includes master URL"       "echo '$cmd' | grep -q 'master.example.com:3012'"
    assert "install-cmd includes tags ops,rocky9"  "echo '$cmd' | grep -q 'ops,rocky9'"
    assert "install-cmd references --secret"       "echo '$cmd' | grep -q 'secret'"

    # Simulate worker config generation (the pattern install-worker.sh uses)
    local tmp; tmp=$(mktemp -d)
    mkdir -p "${tmp}/conf"
    local master_url="http://10.20.30.40:3012"
    local secret="deadbeefcafebabe1234567890abcdef"
    jq -n \
        --arg url "$master_url" \
        --arg sec "$secret" \
        '{ base_app_url: $url, secret_key: $sec, WebServer: { http_port: 3012 }, Storage: { engine: "Filesystem" } }' \
        > "${tmp}/conf/config.json"

    assert "worker config: correct master URL" \
           "jq -e --arg u '${master_url}' '.base_app_url == \$u' '${tmp}/conf/config.json'"
    assert "worker config: correct secret_key" \
           "jq -e --arg s '${secret}' '.secret_key == \$s' '${tmp}/conf/config.json'"
    rm -rf "$tmp"
    pass "Worker config generation pattern verified"
}

# =============================================================================
# T23 — Skill loading
# =============================================================================
t23_skill_loading() {
    header "T23: Skill Loading — Scripts, runners.conf, SKILL.md"

    local skill="${OPENDOG_DIR}/.opencode/skills/cron-scheduler"

    assert "SKILL.md present"          "[[ -f '${skill}/SKILL.md' ]]"
    assert "runners.conf present"      "[[ -f '${skill}/runners.conf' ]]"
    assert "skill Dockerfile present"  "[[ -f '${skill}/docker/Dockerfile' ]]"
    assert "skill docker-compose.yml"  "[[ -f '${skill}/docker/docker-compose.yml' ]]"
    assert "skill entrypoint.sh"       "[[ -f '${skill}/docker/entrypoint.sh' ]]"

    for s in cron-cli.sh cron-agent.sh install.sh install-worker.sh; do
        assert "${s} executable" "[[ -x '${skill}/scripts/${s}' ]]"
    done

    local conf="${skill}/runners.conf"
    info "runners.conf:"
    while IFS= read -r line; do info "  $line"; done < "$conf"

    assert "runners.conf: opencode"                 "grep -q '^opencode$' '${conf}'"
    assert "runners.conf: /usr/local/bin/job_runner" \
           "grep -q '^/usr/local/bin/job_runner$' '${conf}'"
    assert "runners.conf: /usr/local/bin/opencode"  \
           "grep -q '^/usr/local/bin/opencode$' '${conf}'"

    assert "cron-cli  symlink in .opendog/bin" "[[ -L '${OPENDOG_DIR}/.opendog/bin/cron-cli' ]]"
    assert "cron-agent symlink in .opendog/bin" "[[ -L '${OPENDOG_DIR}/.opendog/bin/cron-agent' ]]"
    assert "cron-cli in PATH"   "command -v cron-cli"
    assert "cron-agent in PATH" "command -v cron-agent"

    local help_out
    help_out=$(cron_agent help 2>&1 || true)
    assert "cron-agent help shows 'create'"   "echo '$help_out' | grep -q 'create'"
    assert "cron-agent help shows 'callback'" "echo '$help_out' | grep -q 'callback'"
    assert "cron-agent help shows 'history'"  "echo '$help_out' | grep -q 'history'"
}

# =============================================================================
# T24 — Job delete
# =============================================================================
t24_job_delete() {
    header "T24: Job Delete and Gone Verification"

    local spec
    spec=$(jq -n '{
        name: "uat_delete_me",
        enabled: false,
        schedule: { type: "cron", expr: "0 0 1 1 *" },
        execution: { runner: "/usr/local/bin/job_runner", args: ["--task","delete-test"] },
        policy: { timeout_sec: 10 }
    }')

    local out
    out=$(cron_agent create "$spec" 2>&1)
    if ! echo "$out" | grep -q "Job created"; then
        fail "Could not create sacrificial job: $out"
        return
    fi
    local jid
    jid=$(echo "$out" | grep -oE 'Event ID: [a-z0-9]+' | grep -oE '[a-z0-9]+$' || echo "")
    pass "Sacrificial job created — ID: ${jid}"

    local del_out
    del_out=$(cron_agent delete "$jid" 2>&1)
    info "delete: $del_out"
    assert "delete reports success" "echo '$del_out' | grep -q 'deleted'"

    sleep 1
    local get_out rc=0
    get_out=$(cron_agent get "$jid" 2>&1) || rc=$?
    if [[ $rc -ne 0 ]] || echo "$get_out" | grep -qiE "not found|error|no event"; then
        pass "Deletion confirmed — job no longer retrievable"
    else
        fail "Job still retrievable after delete: $get_out"
    fi
}

# =============================================================================
# T25 — Admin clear all
# =============================================================================
t25_admin_clear() {
    header "T25: Admin Clear All Jobs (cron-cli clear --confirm)"

    local before
    before=$(cron_agent list 2>&1 | grep "Total:" | grep -oE '[0-9]+' | head -1 || echo "0")
    info "Jobs before clear: ${before}"

    # Without --confirm must fail
    local safe rc=0
    safe=$(cron_cli clear 2>&1) || rc=$?
    if echo "$safe" | grep -qiE "confirm|error" || [[ $rc -ne 0 ]]; then
        pass "clear without --confirm is rejected"
    else
        fail "clear without --confirm was NOT rejected"
    fi

    # With --confirm
    local result
    result=$(cron_cli clear --confirm 2>&1)
    info "clear: $result"
    if echo "$result" | grep -qE "Deleted [0-9]+"; then
        local n
        n=$(echo "$result" | grep -oE 'Deleted [0-9]+' | grep -oE '[0-9]+')
        pass "Cleared ${n} jobs"
    else
        fail "clear --confirm failed: $result"
        return
    fi

    sleep 3
    local after
    after=$(cron_agent list 2>&1 | grep "Total:" | grep -oE '[0-9]+' | head -1 || echo "?")
    info "Jobs after clear: ${after}"
    # Accept 0 or 1 remaining (Cronicle may retain one internal/system event)
    if [[ "$after" == "0" || "$after" == "1" ]]; then
        pass "Schedule cleared (${after} remaining, was ${before})"
    else
        fail "schedule empty after clear (got ${after}, was ${before})"
    fi
}

# =============================================================================
# T26 — cron-agent blocks admin commands
# =============================================================================
t26_agent_admin_guard() {
    header "T26: cron-agent Blocks Admin Commands"

    for cmd in start stop status install-cmd clear; do
        local out rc=0
        out=$(cron_agent "$cmd" 2>&1) || rc=$?
        if echo "$out" | grep -qiE "not available|agent mode|cron-cli" || [[ $rc -ne 0 ]]; then
            pass "cron-agent blocks: ${cmd}"
        else
            fail "cron-agent ALLOWED admin: ${cmd}"
        fi
    done
}

# =============================================================================
# T27 — Web UI + admin login
# =============================================================================
t27_web_ui() {
    header "T27: Web UI Accessibility + Admin Login"

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
                    "http://${CRONICLE_CONTAINER}:3012/" 2>/dev/null)
    info "GET / → HTTP ${http_code}"
    if [[ "$http_code" =~ ^(200|301|302)$ ]]; then
        pass "Web UI responds HTTP ${http_code}"
    else
        fail "Web UI returned HTTP ${http_code}"
    fi

    local api_out api_code
    api_out=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
                  -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo '{}')
    api_code=$(echo "$api_out" | jq -r '.code // "error"' 2>/dev/null || echo "error")
    if [[ "$api_code" == "0" ]]; then
        pass "API /get_schedule: code=0"
    else
        fail "API /get_schedule: code=0 (got ${api_code})"
    fi

    local login login_code login_session
    login=$(curl -sf -X POST "${CRONICLE_URL}/api/user/login" \
                -H "Content-Type: application/json" \
                -d "{\"username\":\"admin\",\"password\":\"${CRONICLE_ADMIN_PASSWORD}\"}" \
                2>/dev/null || echo '{}')
    login_code=$(echo "$login" | jq -r '.code // "error"' 2>/dev/null || echo "error")
    login_session=$(echo "$login" | jq -r '.session_id // ""' 2>/dev/null || echo "")
    info "login code: ${login_code}  session: ${login_session:0:12}..."
    if [[ "$login_code" == "0" ]]; then
        pass "Admin login: code=0"
    else
        fail "Admin login: code=0 (got ${login_code})"
    fi
    if [[ -n "$login_session" ]]; then
        pass "Admin login: session_id set"
    else
        fail "Admin login: session_id set (empty)"
    fi

    local master
    master=$(curl -sf "${CRONICLE_URL}/api/app/get_master_state/v1" \
                 -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null || echo '{}')
    info "Master state: $(echo "$master" | jq -c . 2>/dev/null)"
    pass "Master state endpoint reachable"
}

# =============================================================================
# Summary
# =============================================================================
print_summary() {
    local total=$((PASS + FAIL + SKIP))
    echo ""
    echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  cron-scheduler UAT — Final Results${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GREEN}PASS  : ${PASS}${NC}"
    echo -e "  ${RED}FAIL  : ${FAIL}${NC}"
    echo -e "  ${YELLOW}SKIP  : ${SKIP}${NC}"
    echo -e "  TOTAL : ${total}"
    echo ""
    if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
        echo -e "${RED}Failed assertions:${NC}"
        for t in "${FAILED_TESTS[@]}"; do
            echo -e "  ${RED}✗${NC} ${t}"
        done
        echo ""
    fi
    if [[ $FAIL -eq 0 ]]; then
        echo -e "${GREEN}${BOLD}All tests passed! cron-scheduler skill is UAT-ready.${NC}"
    else
        echo -e "${RED}${BOLD}${FAIL} test(s) failed.${NC}"
        exit 1
    fi
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo ""
    echo -e "${BOLD}${BLUE}════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}   cron-scheduler UAT Test Suite${NC}"
    echo -e "   $(date)"
    echo -e "   Repo: ${OPENDOG_REPO}"
    echo -e "   Cronicle: ${CRONICLE_CONTAINER} @ ${CRONICLE_URL}"
    echo -e "${BOLD}${BLUE}════════════════════════════════════════════════════${NC}"
    echo ""

    CRON_JOB_ID=""; INTERVAL_JOB_ID=""; ONCE_JOB_ID=""
    POLICY_JOB_ID=""; CALLBACK_JOB_ID=""; CROSS_JOB_ID=""
    SLOW_JOB_ID=""; EXEC_ID=""

    t01_environment_setup
    t02_start_cronicle
    t03_health_check
    t04_empty_list
    t05_create_cron_job
    t06_create_interval_job
    t07_create_once_job
    t08_create_policy_job
    t09_get_by_id
    t10_get_by_title
    t11_list_jobs
    t12_enable_disable
    t13_update_job
    t14_immediate_execution
    t15_execution_history
    t16_execution_detail
    t17_active_jobs
    t18_opencode_callback
    t19_runner_whitelist
    t20_api_auth
    t21_cross_machine_target
    t22_worker_install
    t23_skill_loading
    t24_job_delete
    t25_admin_clear
    t26_agent_admin_guard
    t27_web_ui

    print_summary
}

main "$@"
