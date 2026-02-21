#!/usr/bin/env bash
# cron-agent: Safe cron operations for AI agents.
# Wraps Cronicle REST API. Per-job CRUD, run-now, query history.
# For admin operations (start/stop/install), see cron-cli.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

# --- Defaults (overridden by env or config-cli vault) ---
CRONICLE_URL="${CRONICLE_URL:-http://localhost:3012}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-}"
OPENCODE_SERVER_URL="${OPENCODE_SERVER_URL:-http://localhost:4096}"
OPENCODE_AUTH="${OPENCODE_AUTH:-}"  # Optional Basic Auth: "user:password"

# Runner whitelist — only these runners are allowed
RUNNER_WHITELIST_FILE="${CRON_RUNNER_WHITELIST:-${OPENDAWG_ROOT}/.opencode/skills/cron-scheduler/runners.conf}"
DEFAULT_RUNNERS=("bash" "/bin/bash" "/bin/sh" "curl" "/usr/local/bin/job_runner")

usage() {
  cat <<'EOF'
Usage: cron-agent <command> [args]

Job Management:
  create <jobspec-json>               Create a job from JobSpec JSON
  update <id> <jobspec-json>          Update a job (partial)
  delete <id>                         Delete a job
  enable <id>                         Enable a job
  disable <id>                        Disable a job
  run <id>                            Run a job immediately
  list [--limit N]                    List all jobs
  get <id-or-title>                   Get job details

Execution History:
  history <id> [--limit N]            Execution history for a job
  execution <id>                      Get execution details
  active                              List running jobs

System:
  health                              Server health check

Convenience:
  callback --session <id> --schedule <cron> [options]
    --script <cmd>          Script mode: run shell command, deliver output to session
    --prompt <text>         Agent mode: run prompt (in session or isolated)
    --isolated              Run prompt in new session, deliver result to callback session
    --name <name>           Job name (default: callback-<session>)
    --host <hostname>       Target host (default: current hostname)
    --server-url <url>      OpenCode server URL (default: OPENCODE_SERVER_URL or http://localhost:4096)
    --auth <user:password>  Basic Auth for OpenCode server (default: OPENCODE_AUTH)

  Modes:
    --script "cmd"                    Run cmd, inject output to session via HTTP API
    --prompt "text" --isolated        Run agent in new session, inject result to session via HTTP API
    --prompt "text"                   Inject prompt directly to session via HTTP API

Environment:
  CRONICLE_URL                        Server URL (default: http://localhost:3012)
  CRONICLE_API_KEY                    API key for authentication
  CRON_RUNNER_WHITELIST               Path to runners.conf whitelist file
  OPENCODE_SERVER_URL                 OpenCode server URL for session callbacks (default: http://localhost:4096)
  OPENCODE_AUTH                       Basic Auth credentials for OpenCode server (user:password)
EOF
}

# ============================================================
# Helpers
# ============================================================

check_prereq() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '${cmd}' is required but not found." >&2
    return 1
  fi
}

inject_secrets() {
  # Inject from config-cli vault if available and values not already set
  if command -v config-cli &>/dev/null; then
    if [[ -z "$CRONICLE_API_KEY" ]]; then
      CRONICLE_API_KEY="$(config-cli get CRONICLE_API_KEY 2>/dev/null || true)"
    fi
    if [[ "$CRONICLE_URL" == "http://localhost:3012" ]]; then
      local vault_url
      vault_url="$(config-cli get CRONICLE_URL 2>/dev/null || true)"
      if [[ -n "$vault_url" ]]; then
        CRONICLE_URL="$vault_url"
      fi
    fi
    if [[ "$OPENCODE_SERVER_URL" == "http://localhost:4096" ]]; then
      local vault_oc_url
      vault_oc_url="$(config-cli get OPENCODE_SERVER_URL 2>/dev/null || true)"
      if [[ -n "$vault_oc_url" ]]; then
        OPENCODE_SERVER_URL="$vault_oc_url"
      fi
    fi
    if [[ -z "$OPENCODE_AUTH" ]]; then
      OPENCODE_AUTH="$(config-cli get OPENCODE_AUTH 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$CRONICLE_API_KEY" ]]; then
    echo "Error: CRONICLE_API_KEY is not set. Set via env or config-cli vault." >&2
    exit 1
  fi
}

# Cronicle API call helper
# $1 = method (GET/POST)
# $2 = endpoint path (e.g., /api/app/get_schedule/v1)
# $3 = JSON body (optional, for POST)
api_call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${CRONICLE_URL}${path}"
  local -a curl_args=(-s -f -w "\n%{http_code}")

  curl_args+=(-H "X-API-Key: ${CRONICLE_API_KEY}")

  if [[ "$method" == "POST" ]]; then
    curl_args+=(-X POST -H "Content-Type: application/json")
    if [[ -n "$body" ]]; then
      curl_args+=(-d "$body")
    fi
  fi

  local response http_code
  response=$(curl "${curl_args[@]}" "$url" 2>&1) || {
    local exit_code=$?
    echo "Error: API call failed (curl exit $exit_code)" >&2
    echo "URL: $url" >&2
    echo "Response: $response" >&2
    return 1
  }

  # Split response body and HTTP code
  http_code=$(echo "$response" | tail -1)
  response=$(echo "$response" | sed '$d')

  # Check for Cronicle error
  local code
  code=$(echo "$response" | jq -r '.code // 0' 2>/dev/null || echo "parse_error")
  if [[ "$code" != "0" ]]; then
    local desc
    desc=$(echo "$response" | jq -r '.description // "Unknown error"' 2>/dev/null)
    echo "Error: Cronicle API error: ${desc} (code: ${code})" >&2
    return 1
  fi

  echo "$response"
}

# ============================================================
# Cron Expression → Cronicle Timing Conversion
# ============================================================

# Parse a single cron field into a JSON array or "null" (meaning all/*)
# $1 = field value, $2 = min, $3 = max
parse_cron_field() {
  local field="$1" min="$2" max="$3"

  if [[ "$field" == "*" ]]; then
    echo "null"
    return
  fi

  local -a values=()
  IFS=',' read -ra parts <<< "$field"
  for part in "${parts[@]}"; do
    if [[ "$part" =~ ^([0-9]+)-([0-9]+)/([0-9]+)$ ]]; then
      # Range with step: 1-5/2
      local start="${BASH_REMATCH[1]}" end="${BASH_REMATCH[2]}" step="${BASH_REMATCH[3]}"
      for ((i=start; i<=end; i+=step)); do values+=("$i"); done
    elif [[ "$part" =~ ^\*/([0-9]+)$ ]]; then
      # Step: */15
      local step="${BASH_REMATCH[1]}"
      for ((i=min; i<=max; i+=step)); do values+=("$i"); done
    elif [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      # Range: 1-5
      local start="${BASH_REMATCH[1]}" end="${BASH_REMATCH[2]}"
      for ((i=start; i<=end; i++)); do values+=("$i"); done
    elif [[ "$part" =~ ^[0-9]+$ ]]; then
      # Single value
      values+=("$part")
    else
      echo "Error: Invalid cron field component: '$part'" >&2
      return 1
    fi
  done

  # Output as JSON array
  local IFS=','
  echo "[${values[*]}]"
}

# Convert 5-field cron expression to Cronicle timing JSON object
# $1 = cron expression (e.g., "0 9 * * 1-5")
cron_to_timing() {
  local expr="$1"
  local -a fields
  read -ra fields <<< "$expr"

  if [[ ${#fields[@]} -ne 5 ]]; then
    echo "Error: Cron expression must have exactly 5 fields: '$expr'" >&2
    return 1
  fi

  local minutes hours days months weekdays
  minutes=$(parse_cron_field "${fields[0]}" 0 59) || return 1
  hours=$(parse_cron_field "${fields[1]}" 0 23) || return 1
  days=$(parse_cron_field "${fields[2]}" 1 31) || return 1
  months=$(parse_cron_field "${fields[3]}" 1 12) || return 1
  weekdays=$(parse_cron_field "${fields[4]}" 0 6) || return 1

  # Build timing object (omit null fields)
  local timing="{"
  local first=true
  if [[ "$minutes" != "null" ]]; then
    [[ "$first" != true ]] && timing+=","
    timing+="\"minutes\":${minutes}"
    first=false
  fi
  if [[ "$hours" != "null" ]]; then
    [[ "$first" != true ]] && timing+=","
    timing+="\"hours\":${hours}"
    first=false
  fi
  if [[ "$days" != "null" ]]; then
    [[ "$first" != true ]] && timing+=","
    timing+="\"days\":${days}"
    first=false
  fi
  if [[ "$months" != "null" ]]; then
    [[ "$first" != true ]] && timing+=","
    timing+="\"months\":${months}"
    first=false
  fi
  if [[ "$weekdays" != "null" ]]; then
    [[ "$first" != true ]] && timing+=","
    timing+="\"weekdays\":${weekdays}"
    first=false
  fi
  timing+="}"

  echo "$timing"
}

# Convert "every" duration to Cronicle timing
# $1 = duration string (e.g., "30m", "2h", "1d")
every_to_timing() {
  local dur="$1"
  local val unit
  if [[ "$dur" =~ ^([0-9]+)([mhd])$ ]]; then
    val="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]}"
  else
    echo "Error: Invalid 'every' duration: '$dur'. Use format like 30m, 2h, 1d" >&2
    return 1
  fi

  case "$unit" in
    m)
      if ((val < 1 || val > 59)); then
        echo "Error: Minute interval must be 1-59" >&2
        return 1
      fi
      local -a mins=()
      for ((i=0; i<60; i+=val)); do mins+=("$i"); done
      local IFS=','
      echo "{\"minutes\":[${mins[*]}]}"
      ;;
    h)
      if ((val < 1 || val > 23)); then
        echo "Error: Hour interval must be 1-23" >&2
        return 1
      fi
      local -a hrs=()
      for ((i=0; i<24; i+=val)); do hrs+=("$i"); done
      local IFS=','
      echo "{\"hours\":[${hrs[*]}],\"minutes\":[0]}"
      ;;
    d)
      # Every N days — run at midnight. For N>1, we approximate with day-of-month.
      echo "{\"hours\":[0],\"minutes\":[0]}"
      ;;
  esac
}

# Convert "once" ISO datetime to Cronicle timing
# $1 = ISO datetime (e.g., "2025-06-15T09:00:00")
once_to_timing() {
  local dt="$1"
  local year month day hour minute
  if [[ "$dt" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}) ]]; then
    year="${BASH_REMATCH[1]}"
    month=$((10#${BASH_REMATCH[2]}))
    day=$((10#${BASH_REMATCH[3]}))
    hour=$((10#${BASH_REMATCH[4]}))
    minute=$((10#${BASH_REMATCH[5]}))
  else
    echo "Error: Invalid datetime format: '$dt'. Use ISO 8601: YYYY-MM-DDTHH:MM:SS" >&2
    return 1
  fi
  echo "{\"years\":[${year}],\"months\":[${month}],\"days\":[${day}],\"hours\":[${hour}],\"minutes\":[${minute}]}"
}

# ============================================================
# Runner Whitelist
# ============================================================

check_runner_whitelist() {
  local runner="$1"

  # Check default runners
  for r in "${DEFAULT_RUNNERS[@]}"; do
    if [[ "$runner" == "$r" ]]; then
      return 0
    fi
  done

  # Check whitelist file
  if [[ -f "$RUNNER_WHITELIST_FILE" ]]; then
    while IFS= read -r line; do
      line=$(echo "$line" | sed 's/#.*//' | xargs)
      [[ -z "$line" ]] && continue
      if [[ "$runner" == "$line" ]]; then
        return 0
      fi
    done < "$RUNNER_WHITELIST_FILE"
  fi

  echo "Error: Runner '${runner}' is not in the whitelist." >&2
  echo "Allowed runners: ${DEFAULT_RUNNERS[*]}" >&2
  echo "Add custom runners to: ${RUNNER_WHITELIST_FILE}" >&2
  return 1
}

# ============================================================
# JobSpec → Cronicle Event Conversion
# ============================================================

# Convert JobSpec JSON to Cronicle create_event API payload
# $1 = JobSpec JSON string
jobspec_to_event() {
  local jobspec="$1"

  # Extract fields from JobSpec using jq
  local name enabled schedule_type schedule_expr schedule_tz
  local runner target_tags timeout_sec retries
  name=$(echo "$jobspec" | jq -r '.name // empty')
  enabled=$(echo "$jobspec" | jq -r 'if .enabled == null then "true" else (.enabled | tostring) end')
  schedule_type=$(echo "$jobspec" | jq -r '.schedule.type // "cron"')
  schedule_expr=$(echo "$jobspec" | jq -r '.schedule.expr // empty')
  schedule_tz=$(echo "$jobspec" | jq -r '.schedule.timezone // "UTC"')
  runner=$(echo "$jobspec" | jq -r '.execution.runner // empty')
  timeout_sec=$(echo "$jobspec" | jq -r '.policy.timeout_sec // 0')
  retries=$(echo "$jobspec" | jq -r '.policy.retries // 0')

  if [[ -z "$name" ]]; then
    echo "Error: JobSpec requires 'name' field" >&2
    return 1
  fi
  if [[ -z "$runner" ]]; then
    echo "Error: JobSpec requires 'execution.runner' field" >&2
    return 1
  fi
  if [[ -z "$schedule_expr" ]]; then
    echo "Error: JobSpec requires 'schedule.expr' field" >&2
    return 1
  fi

  # Validate runner against whitelist
  check_runner_whitelist "$runner" || return 1

  # Build shell script from runner + args (with shebang for portability)
  local args_json script_content
  args_json=$(echo "$jobspec" | jq -c '.execution.args // []')
  # Build a properly quoted command line with #!/bin/sh shebang
  script_content=$(echo "$jobspec" | jq -r '
    .execution.runner as $runner |
    (.execution.args // []) | map(@sh) | join(" ") |
    if . == "" then "#!/bin/sh\n" + $runner else "#!/bin/sh\n" + $runner + " " + . end
  ')

  # Convert schedule to Cronicle timing
  local timing
  case "$schedule_type" in
    cron)
      timing=$(cron_to_timing "$schedule_expr") || return 1
      ;;
    every)
      timing=$(every_to_timing "$schedule_expr") || return 1
      ;;
    once)
      timing=$(once_to_timing "$schedule_expr") || return 1
      ;;
    *)
      echo "Error: Unknown schedule type: '$schedule_type'. Use: cron, every, once" >&2
      return 1
      ;;
  esac

  # Determine target (default: allgrp = All Servers)
  local target="allgrp"
  local target_hostname
  target_hostname=$(echo "$jobspec" | jq -r '.target.hostname // empty')
  if [[ -n "$target_hostname" ]]; then
    target="$target_hostname"
  fi

  # Map enabled boolean
  local enabled_int=1
  if [[ "$enabled" == "false" || "$enabled" == "0" ]]; then
    enabled_int=0
  fi

  # Build Cronicle event payload
  local event_json
  event_json=$(jq -n \
    --arg title "$name" \
    --argjson enabled "$enabled_int" \
    --arg category "general" \
    --arg plugin "shellplug" \
    --arg target "$target" \
    --argjson timing "$timing" \
    --arg timezone "$schedule_tz" \
    --argjson timeout "${timeout_sec:-0}" \
    --argjson retries "${retries:-0}" \
    --arg script "$script_content" \
    '{
      title: $title,
      enabled: $enabled,
      category: $category,
      plugin: $plugin,
      target: $target,
      timing: $timing,
      timezone: $timezone,
      timeout: $timeout,
      retries: $retries,
      params: {
        script: $script,
        annotate: 0
      }
    }')

  echo "$event_json"
}

# ============================================================
# Commands
# ============================================================

cmd_create() {
  local jobspec="${1:?Error: JobSpec JSON required. Usage: cron-agent create '<json>'}"
  check_prereq jq

  # Validate JSON
  echo "$jobspec" | jq empty 2>/dev/null || {
    echo "Error: Invalid JSON: $jobspec" >&2
    return 1
  }

  local event_json
  event_json=$(jobspec_to_event "$jobspec") || return 1

  local result
  result=$(api_call POST "/api/app/create_event/v1" "$event_json") || return 1

  local event_id
  event_id=$(echo "$result" | jq -r '.id // "unknown"')
  echo "Job created successfully. Event ID: ${event_id}"
  echo "$result" | jq '.'
}

cmd_update() {
  local id="${1:?Error: Job ID required. Usage: cron-agent update <id> '<json>'}"
  local jobspec="${2:?Error: JobSpec JSON required.}"
  check_prereq jq

  echo "$jobspec" | jq empty 2>/dev/null || {
    echo "Error: Invalid JSON" >&2
    return 1
  }

  # Start with a valid JSON object containing the event ID
  local update_json
  update_json=$(jq -n --arg id "$id" '{id: $id}')

  # Name
  local name
  name=$(echo "$jobspec" | jq -r '.name // empty')
  [[ -n "$name" ]] && update_json=$(echo "$update_json" | jq --arg t "$name" '. + {title: $t}')

  # Enabled
  local enabled
  enabled=$(echo "$jobspec" | jq -r '.enabled // empty')
  if [[ -n "$enabled" ]]; then
    if [[ "$enabled" == "true" || "$enabled" == "1" ]]; then
      update_json=$(echo "$update_json" | jq '. + {enabled: 1}')
    else
      update_json=$(echo "$update_json" | jq '. + {enabled: 0}')
    fi
  fi

  # Schedule
  local schedule_type schedule_expr schedule_tz
  schedule_type=$(echo "$jobspec" | jq -r '.schedule.type // empty')
  schedule_expr=$(echo "$jobspec" | jq -r '.schedule.expr // empty')
  schedule_tz=$(echo "$jobspec" | jq -r '.schedule.timezone // empty')
  if [[ -n "$schedule_expr" && -n "$schedule_type" ]]; then
    local timing
    case "$schedule_type" in
      cron)  timing=$(cron_to_timing "$schedule_expr") || return 1 ;;
      every) timing=$(every_to_timing "$schedule_expr") || return 1 ;;
      once)  timing=$(once_to_timing "$schedule_expr") || return 1 ;;
    esac
    update_json=$(echo "$update_json" | jq --argjson t "$timing" '. + {timing: $t}')
  fi
  if [[ -n "$schedule_tz" ]]; then
    update_json=$(echo "$update_json" | jq --arg tz "$schedule_tz" '. + {timezone: $tz}')
  fi

  # Execution
  local runner
  runner=$(echo "$jobspec" | jq -r '.execution.runner // empty')
  if [[ -n "$runner" ]]; then
    check_runner_whitelist "$runner" || return 1
    local script_content
    script_content=$(echo "$jobspec" | jq -r '
      .execution.runner as $runner |
      (.execution.args // []) | map(@sh) | join(" ") |
      if . == "" then "#!/bin/sh\n" + $runner else "#!/bin/sh\n" + $runner + " " + . end
    ')
    update_json=$(echo "$update_json" | jq --arg s "$script_content" '. + {params: {script: $s, annotate: 0}}')
  fi

  # Policy
  local timeout_sec retries
  timeout_sec=$(echo "$jobspec" | jq -r '.policy.timeout_sec // empty')
  retries=$(echo "$jobspec" | jq -r '.policy.retries // empty')
  [[ -n "$timeout_sec" ]] && update_json=$(echo "$update_json" | jq --argjson t "$timeout_sec" '. + {timeout: $t}')
  [[ -n "$retries" ]] && update_json=$(echo "$update_json" | jq --argjson r "$retries" '. + {retries: $r}')

  local result
  result=$(api_call POST "/api/app/update_event/v1" "$update_json") || return 1
  echo "Job updated successfully."
  echo "$result" | jq '.'
}

cmd_delete() {
  local id="${1:?Error: Job ID required. Usage: cron-agent delete <id>}"
  local result
  result=$(api_call POST "/api/app/delete_event/v1" "{\"id\":\"${id}\"}") || return 1
  echo "Job deleted: ${id}"
}

cmd_enable() {
  local id="${1:?Error: Job ID required. Usage: cron-agent enable <id>}"
  local result
  result=$(api_call POST "/api/app/update_event/v1" "{\"id\":\"${id}\",\"enabled\":1}") || return 1
  echo "Job enabled: ${id}"
}

cmd_disable() {
  local id="${1:?Error: Job ID required. Usage: cron-agent disable <id>}"
  local result
  result=$(api_call POST "/api/app/update_event/v1" "{\"id\":\"${id}\",\"enabled\":0}") || return 1
  echo "Job disabled: ${id}"
}

cmd_run() {
  local id="${1:?Error: Job ID required. Usage: cron-agent run <id>}"
  local result
  result=$(api_call POST "/api/app/run_event/v1" "{\"id\":\"${id}\"}") || return 1
  local job_ids
  job_ids=$(echo "$result" | jq -r '.ids // [] | join(", ")')
  echo "Job triggered. Execution IDs: ${job_ids}"
  echo "$result" | jq '.'
}

cmd_list() {
  local limit=50 offset=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)  limit="${2:?Error: --limit requires a number}"; shift 2 ;;
      --offset) offset="${2:?Error: --offset requires a number}"; shift 2 ;;
      *) echo "Error: Unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  local result
  result=$(api_call GET "/api/app/get_schedule/v1?offset=${offset}&limit=${limit}") || return 1

  # Format as table
  echo "$result" | jq -r '
    .rows // [] |
    ["ID", "TITLE", "ENABLED", "CATEGORY", "TARGET"],
    (.[] | [.id, .title, (if .enabled == 1 then "yes" else "no" end), .category, .target]) |
    @tsv
  ' | column -t -s $'\t'

  local total
  total=$(echo "$result" | jq -r '.list.length // 0')
  echo ""
  echo "Total: ${total} jobs (showing offset=${offset}, limit=${limit})"
}

cmd_get() {
  local id_or_title="${1:?Error: Job ID or title required. Usage: cron-agent get <id-or-title>}"

  # Try by ID first, then by title
  local result
  result=$(api_call GET "/api/app/get_event/v1?id=${id_or_title}" 2>/dev/null) || \
  result=$(api_call GET "/api/app/get_event/v1?title=$(printf '%s' "$id_or_title" | jq -sRr @uri)" 2>/dev/null) || {
    echo "Error: Job not found: ${id_or_title}" >&2
    return 1
  }

  echo "$result" | jq '.event'
}

cmd_history() {
  local id="${1:?Error: Job ID required. Usage: cron-agent history <id> [--limit N]}"
  shift
  local limit=20 offset=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)  limit="${2:?}"; shift 2 ;;
      --offset) offset="${2:?}"; shift 2 ;;
      *) shift ;;
    esac
  done

  local result
  result=$(api_call GET "/api/app/get_event_history/v1?id=${id}&offset=${offset}&limit=${limit}") || return 1

  echo "$result" | jq -r '
    .rows // [] |
    ["JOB_ID", "EVENT_TITLE", "STATUS", "HOSTNAME", "ELAPSED", "CODE"],
    (.[] | [
      .id,
      .event_title,
      (if .code == 0 then "success" elif .code then "failed(\(.code))" else "running" end),
      .hostname,
      (.elapsed | tostring | .[0:6] + "s"),
      (.code // "–" | tostring)
    ]) |
    @tsv
  ' | column -t -s $'\t'

  local total
  total=$(echo "$result" | jq -r '.list.length // 0')
  echo ""
  echo "Total: ${total} executions"
}

cmd_execution() {
  local id="${1:?Error: Execution/Job ID required. Usage: cron-agent execution <id>}"
  local result
  result=$(api_call GET "/api/app/get_job_status/v1?id=${id}") || return 1
  echo "$result" | jq '.job'
}

cmd_active() {
  local result
  result=$(api_call GET "/api/app/get_active_jobs/v1") || return 1

  local count
  count=$(echo "$result" | jq '.jobs | length')
  if [[ "$count" == "0" ]]; then
    echo "No active jobs."
    return
  fi

  echo "$result" | jq -r '
    .jobs | to_entries[] | .value |
    "ID: \(.id)  Event: \(.event_title)  Host: \(.hostname)  Progress: \(.progress // 0 | . * 100 | floor)%  Elapsed: \(.elapsed // 0 | tostring | .[0:6])s"
  '
}

cmd_health() {
  local result
  result=$(curl -sf "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
    -H "X-API-Key: ${CRONICLE_API_KEY}" 2>&1) || {
    echo "UNHEALTHY: Cannot reach Cronicle at ${CRONICLE_URL}"
    return 1
  }
  echo "HEALTHY: Cronicle is running at ${CRONICLE_URL}"
  local job_count
  job_count=$(echo "$result" | jq -r '.list.length // 0')
  echo "Jobs: ${job_count}"
}

cmd_callback() {
  local session_id="" schedule_expr="" name="" prompt="" target_host=""
  local schedule_type="cron" timezone="UTC"
  local script_cmd="" isolated=false
  local oc_server_url="" oc_auth=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session)    session_id="${2:?Error: --session requires a session ID}"; shift 2 ;;
      --schedule)   schedule_expr="${2:?Error: --schedule requires a cron expression}"; shift 2 ;;
      --name)       name="${2:?Error: --name requires a value}"; shift 2 ;;
      --prompt)     prompt="${2:?Error: --prompt requires a value}"; shift 2 ;;
      --script)     script_cmd="${2:?Error: --script requires a command}"; shift 2 ;;
      --isolated)   isolated=true; shift ;;
      --host)       target_host="${2:?Error: --host requires a hostname}"; shift 2 ;;
      --type)       schedule_type="${2:?}"; shift 2 ;;
      --timezone)   timezone="${2:?}"; shift 2 ;;
      --server-url) oc_server_url="${2:?Error: --server-url requires a URL}"; shift 2 ;;
      --auth)       oc_auth="${2:?Error: --auth requires user:password}"; shift 2 ;;
      *) echo "Error: Unknown flag '$1'" >&2; return 1 ;;
    esac
  done

  if [[ -z "$session_id" ]]; then
    echo "Error: --session is required" >&2
    return 1
  fi
  if [[ -z "$schedule_expr" ]]; then
    echo "Error: --schedule is required" >&2
    return 1
  fi
  if [[ -z "$script_cmd" && -z "$prompt" ]]; then
    echo "Error: --script or --prompt is required" >&2
    return 1
  fi

  [[ -z "$name" ]] && name="callback-${session_id}"
  [[ -z "$target_host" ]] && target_host="$(hostname)"

  # Resolve OpenCode server URL and auth (flag > env/vault)
  [[ -z "$oc_server_url" ]] && oc_server_url="$OPENCODE_SERVER_URL"
  [[ -z "$oc_auth" ]] && oc_auth="$OPENCODE_AUTH"

  # Resolve opendawg-agent.sh path (still used for isolated mode Phase 1)
  local agent_script="${OPENDAWG_ROOT}/.opencode/skills/opendawg-agent/scripts/opendawg-agent.sh"

  # --- Build the Phase 2 delivery snippet (inject via HTTP API) ---
  # Uses curl to POST directly to opencode server's /session/:id/prompt endpoint.
  # This avoids "opencode run -s" which can fail with:
  #   "This model does not support assistant message prefill.
  #    The conversation must end with a user message."
  # when the session's last message is already an assistant reply.
  #
  # curl args:
  #   -s -f              silent + fail on HTTP error
  #   -X POST            POST request
  #   -H "Content-Type"  JSON body
  #   -u user:pass       Basic Auth (only if OPENCODE_AUTH is set)
  #   --data-raw         JSON payload with parts array
  local phase2_snippet
  phase2_snippet=$(jq -n -r \
    --arg oc_url "$oc_server_url" \
    --arg oc_auth "$oc_auth" \
    '
    "# Phase 2: Inject result into callback session via opencode HTTP API\n" +
    "# (direct HTTP avoids opencode run -s prefill issues)\n" +
    "OPENCODE_URL=" + ($oc_url | @sh) + "\n" +
    "OPENCODE_AUTH=" + ($oc_auth | @sh) + "\n\n" +
    "AUTH_ARGS=()\n" +
    "if [[ -n \"$OPENCODE_AUTH\" ]]; then\n" +
    "  AUTH_ARGS=(-u \"$OPENCODE_AUTH\")\n" +
    "fi\n\n" +
    "echo \"[cron:${JOB_NAME}] Phase 2: Delivering result to session ${CALLBACK_SESSION} via HTTP...\"\n" +
    "# Pipe JSON payload via stdin to avoid shell quoting issues with special chars\n" +
    "# Uses /prompt_async (returns 204 No Content) — fire-and-forget, no prefill risk\n" +
    "HTTP_CODE=$(jq -n --arg text \"$DELIVERY_MSG\" '\''{parts:[{type:\"text\",text:$text}]}'\'' | curl -sf -o /dev/null -w \"%{http_code}\" -X POST -H \"Content-Type: application/json\" \"${AUTH_ARGS[@]+${AUTH_ARGS[@]}}\" --data @- \"${OPENCODE_URL}/session/${CALLBACK_SESSION}/prompt_async\" 2>&1) || {\n" +
    "  echo \"[cron:${JOB_NAME}] ERROR: Failed to deliver result to session (HTTP ${HTTP_CODE}).\" >&2\n" +
    "  exit 1\n" +
    "}\n" +
    "echo \"[cron:${JOB_NAME}] Result delivered successfully (HTTP ${HTTP_CODE}).\""
    ')

  # --- Build the two-phase Cronicle shell script using jq (safe escaping) ---
  # Phase 1: Execute task and collect output
  # Phase 2: Inject result into callback session via HTTP API (not opencode run -s)
  local cron_script=""

  if [[ -n "$script_cmd" ]]; then
    # --- Script mode: run a shell command directly, no agent needed ---
    cron_script=$(jq -n -r \
      --arg job_name "$name" \
      --arg session "$session_id" \
      --arg cmd "$script_cmd" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\n\n# Phase 1: Execute script and capture output\nRESULT_FILE=\"$(mktemp)\"\ntrap '\''rm -f \"$RESULT_FILE\"'\'' EXIT\n\necho \"[cron:${JOB_NAME}] Phase 1: Executing task...\"\nif ( " + $cmd + " ) > \"$RESULT_FILE\" 2>&1; then\n  STATUS=\"completed successfully\"\nelse\n  STATUS=\"completed with errors (exit=$?)\"\nfi\nRESULT=\"$(cat \"$RESULT_FILE\")\"\n\n# Build delivery message\nDELIVERY_MSG=\"[Cron Task: ${JOB_NAME}] ${STATUS}\n\nThis is an automated cron task result. Please summarize and present this to the user in a clean format.\n\n--- Raw Output ---\n${RESULT}\n--- End Output ---\"\n\n" + $phase2')

  elif [[ "$isolated" = true ]]; then
    # --- Isolated agent mode: run prompt in new session, deliver result to callback ---
    cron_script=$(jq -n -r \
      --arg job_name "$name" \
      --arg session "$session_id" \
      --arg agent "$agent_script" \
      --arg prompt "$prompt" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\nAGENT_SCRIPT=" + ($agent | @sh) +
       "\nPROMPT=" + ($prompt | @sh) +
       "\n\n# Phase 1: Execute in isolated (new) session and capture output\nRESULT_FILE=\"$(mktemp)\"\ntrap '\''rm -f \"$RESULT_FILE\"'\'' EXIT\n\necho \"[cron:${JOB_NAME}] Phase 1: Running agent in isolated session...\"\nif \"$AGENT_SCRIPT\" \"$PROMPT\" > \"$RESULT_FILE\" 2>&1; then\n  STATUS=\"completed successfully\"\nelse\n  STATUS=\"completed with errors (exit=$?)\"\nfi\nRESULT=\"$(cat \"$RESULT_FILE\")\"\n\n# Build delivery message\nDELIVERY_MSG=\"[Cron Task: ${JOB_NAME}] ${STATUS}\n\nThis is an automated cron task result from an isolated agent session. Please summarize and present this to the user in a clean format.\n\n--- Agent Output ---\n${RESULT}\n--- End Output ---\"\n\n" + $phase2')

  else
    # --- Direct mode: inject prompt directly into callback session via HTTP API ---
    cron_script=$(jq -n -r \
      --arg job_name "$name" \
      --arg session "$session_id" \
      --arg prompt "$prompt" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\n\n# Build delivery message (no phase 1 — prompt is the message)\nDELIVERY_MSG=" + ($prompt | @sh) +
       "\n\n" + $phase2')
  fi

  # Build Cronicle event via direct API (bypass jobspec since we have a custom script)
  local timing
  case "$schedule_type" in
    cron)  timing=$(cron_to_timing "$schedule_expr") || return 1 ;;
    every) timing=$(every_to_timing "$schedule_expr") || return 1 ;;
    once)  timing=$(once_to_timing "$schedule_expr") || return 1 ;;
    *)     echo "Error: Unknown schedule type: '$schedule_type'" >&2; return 1 ;;
  esac

  local event_json
  event_json=$(jq -n \
    --arg title "$name" \
    --arg target "$target_host" \
    --argjson timing "$timing" \
    --arg timezone "$timezone" \
    --arg script "$cron_script" \
    '{
      title: $title,
      enabled: 1,
      category: "general",
      plugin: "shellplug",
      target: $target,
      timing: $timing,
      timezone: $timezone,
      timeout: 3600,
      retries: 0,
      params: { script: $script, annotate: 0 }
    }')

  local mode_desc="direct"
  [[ -n "$script_cmd" ]] && mode_desc="script → callback"
  [[ "$isolated" = true ]] && mode_desc="isolated agent → callback"

  echo "Creating callback job:"
  echo "  Session: ${session_id}"
  echo "  Schedule: ${schedule_expr} (${schedule_type})"
  echo "  Target: ${target_host} (host worker)"
  echo "  Mode: ${mode_desc}"
  [[ -n "$script_cmd" ]] && echo "  Script: ${script_cmd}"
  [[ -n "$prompt" ]] && echo "  Prompt: ${prompt}"
  echo ""

  local result
  result=$(api_call POST "/api/app/create_event/v1" "$event_json") || return 1
  local event_id
  event_id=$(echo "$result" | jq -r '.id // "unknown"')
  echo "Job created successfully. Event ID: ${event_id}"
  echo "$result" | jq '.'
}

# ============================================================
# Dispatch
# ============================================================

inject_secrets

case "${1:-help}" in
  create)     shift; cmd_create "$@" ;;
  update)     shift; cmd_update "$@" ;;
  delete)     shift; cmd_delete "$@" ;;
  enable)     shift; cmd_enable "$@" ;;
  disable)    shift; cmd_disable "$@" ;;
  run)        shift; cmd_run "$@" ;;
  list)       shift; cmd_list "$@" ;;
  get)        shift; cmd_get "$@" ;;
  history)    shift; cmd_history "$@" ;;
  execution)  shift; cmd_execution "$@" ;;
  active)     shift; cmd_active "$@" ;;
  health)     shift; cmd_health "$@" ;;
  callback)   shift; cmd_callback "$@" ;;
  help|--help|-h) usage ;;
  start|stop|status|install-cmd|clear)
    echo "Error: '${1}' is not available in agent mode. Use cron-cli for admin operations." >&2
    exit 1
    ;;
  *)
    echo "Error: Unknown command '${1}'" >&2
    usage >&2
    exit 1
    ;;
esac
