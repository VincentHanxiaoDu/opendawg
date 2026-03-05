#!/usr/bin/env bash
# _cron-lib.sh — Shared library for cron-scheduler plugin.
# Sourced by cron-cli.sh, cron-agent.sh. Not executed directly.

# --- Constants ---
OPENDAWG_ROOT="${OPENDAWG_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
export PATH="${OPENDAWG_ROOT}/.opendawg/bin:${PATH}"

BIN_DIR="${OPENDAWG_ROOT}/.opendawg/bin"
CRONICLE_HOME="${OPENDAWG_ROOT}/.opendawg/cronicle"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNERS_CONF="${PLUGIN_DIR}/runners.conf"

# --- Defaults (overridden by env or vault) ---
CRONICLE_URL="${CRONICLE_URL:-http://localhost:3012}"
CRONICLE_PORT="${CRONICLE_PORT:-3012}"
CRONICLE_API_KEY="${CRONICLE_API_KEY:-}"
OPENCODE_SERVER_URL="${OPENCODE_SERVER_URL:-http://localhost:4096}"
OPENCODE_AUTH="${OPENCODE_AUTH:-}"

DEFAULT_RUNNERS=("bash" "/bin/bash" "/bin/sh" "curl" "/usr/local/bin/job_runner")

# --- Utilities ---
die()         { echo "Error: $*" >&2; exit 1; }
require_arg() { [[ -n "${2:-}" ]] || die "$1"; }
format_json() { jq '.' 2>/dev/null || cat; }

# --- Vault helpers ---
vault_get() { config-cli get "$1" 2>/dev/null || true; }
vault_set() { config-cli set "$1" "$2" 2>/dev/null || true; }

# --- Config loading ---
load_config() {
  command -v config-cli &>/dev/null || return 0
  if [[ -z "$CRONICLE_API_KEY" ]]; then
    CRONICLE_API_KEY="$(vault_get CRONICLE_API_KEY)"
  fi
  if [[ "$CRONICLE_URL" == "http://localhost:3012" ]]; then
    local v; v="$(vault_get CRONICLE_URL)"
    [[ -n "$v" ]] && CRONICLE_URL="$v"
  fi
  if [[ "$OPENCODE_SERVER_URL" == "http://localhost:4096" ]]; then
    local v; v="$(vault_get OPENCODE_SERVER_URL)"
    [[ -n "$v" ]] && OPENCODE_SERVER_URL="$v"
  fi
  if [[ -z "$OPENCODE_AUTH" ]]; then
    OPENCODE_AUTH="$(vault_get OPENCODE_AUTH)"
  fi
}

require_api_key() {
  [[ -n "$CRONICLE_API_KEY" ]] || die "CRONICLE_API_KEY not set. Run 'cron-cli start' or set via env/vault."
}

# --- API wrapper ---
cronicle_api() {
  local method="$1" endpoint="$2" data="${3:-}"
  local url="${CRONICLE_URL}${endpoint}"
  local -a args=(-s -f -w "\n%{http_code}" -H "X-API-Key: ${CRONICLE_API_KEY}")

  if [[ "$method" == "POST" ]]; then
    args+=(-X POST -H "Content-Type: application/json")
    [[ -n "$data" ]] && args+=(-d "$data")
  fi

  local response
  response=$(curl "${args[@]}" "$url" 2>&1) || {
    echo "Error: API call failed (curl exit $?, URL: $url)" >&2
    return 1
  }

  local http_code body
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  local code
  code=$(echo "$body" | jq -r '.code // 0' 2>/dev/null || echo "parse_error")
  if [[ "$code" != "0" ]]; then
    local desc
    desc=$(echo "$body" | jq -r '.description // "Unknown error"' 2>/dev/null)
    echo "Error: Cronicle API: ${desc} (code: ${code})" >&2
    return 1
  fi

  echo "$body"
}

# ============================================================
# Schedule Conversion
# ============================================================

detect_schedule_type() {
  local raw="$1"
  if [[ "$raw" =~ ^[0-9]+[mhd]$ ]]; then
    echo "every"
  elif [[ "$raw" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
    echo "once"
  else
    echo "cron"
  fi
}

parse_cron_field() {
  local field="$1" min="$2" max="$3"
  if [[ "$field" == "*" ]]; then echo "null"; return; fi

  local -a values=()
  IFS=',' read -ra parts <<< "$field"
  for part in "${parts[@]}"; do
    if [[ "$part" =~ ^([0-9]+)-([0-9]+)/([0-9]+)$ ]]; then
      local s="${BASH_REMATCH[1]}" e="${BASH_REMATCH[2]}" step="${BASH_REMATCH[3]}"
      for ((i=s; i<=e; i+=step)); do values+=("$i"); done
    elif [[ "$part" =~ ^\*/([0-9]+)$ ]]; then
      local step="${BASH_REMATCH[1]}"
      for ((i=min; i<=max; i+=step)); do values+=("$i"); done
    elif [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      local s="${BASH_REMATCH[1]}" e="${BASH_REMATCH[2]}"
      for ((i=s; i<=e; i++)); do values+=("$i"); done
    elif [[ "$part" =~ ^[0-9]+$ ]]; then
      values+=("$part")
    else
      echo "Error: Invalid cron field: '$part'" >&2; return 1
    fi
  done

  local IFS=','
  echo "[${values[*]}]"
}

cron_to_timing() {
  local expr="$1"
  local -a fields
  read -ra fields <<< "$expr"
  [[ ${#fields[@]} -eq 5 ]] || { echo "Error: Cron must have 5 fields: '$expr'" >&2; return 1; }

  local minutes hours days months weekdays
  minutes=$(parse_cron_field "${fields[0]}" 0 59) || return 1
  hours=$(parse_cron_field "${fields[1]}" 0 23) || return 1
  days=$(parse_cron_field "${fields[2]}" 1 31) || return 1
  months=$(parse_cron_field "${fields[3]}" 1 12) || return 1
  weekdays=$(parse_cron_field "${fields[4]}" 0 6) || return 1

  local timing="{" first=true
  for pair in "minutes:$minutes" "hours:$hours" "days:$days" "months:$months" "weekdays:$weekdays"; do
    local key="${pair%%:*}" val="${pair#*:}"
    if [[ "$val" != "null" ]]; then
      [[ "$first" != true ]] && timing+=","
      timing+="\"${key}\":${val}"
      first=false
    fi
  done
  timing+="}"
  echo "$timing"
}

every_to_timing() {
  local dur="$1" val unit
  [[ "$dur" =~ ^([0-9]+)([mhd])$ ]] || { echo "Error: Invalid duration: '$dur'. Use 30m/2h/1d" >&2; return 1; }
  val="${BASH_REMATCH[1]}" unit="${BASH_REMATCH[2]}"

  case "$unit" in
    m)
      ((val >= 1 && val <= 59)) || { echo "Error: Minute interval must be 1-59" >&2; return 1; }
      local -a a=(); for ((i=0; i<60; i+=val)); do a+=("$i"); done
      local IFS=','; echo "{\"minutes\":[${a[*]}]}" ;;
    h)
      ((val >= 1 && val <= 23)) || { echo "Error: Hour interval must be 1-23" >&2; return 1; }
      local -a a=(); for ((i=0; i<24; i+=val)); do a+=("$i"); done
      local IFS=','; echo "{\"hours\":[${a[*]}],\"minutes\":[0]}" ;;
    d)
      ((val >= 1 && val <= 30)) || { echo "Error: Day interval must be 1-30" >&2; return 1; }
      local -a a=(); for ((i=1; i<=31; i+=val)); do a+=("$i"); done
      local IFS=','; echo "{\"days\":[${a[*]}],\"hours\":[0],\"minutes\":[0]}" ;;
  esac
}

once_to_timing() {
  local dt="$1"
  if [[ "$dt" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}) ]]; then
    local year="${BASH_REMATCH[1]}"
    local month=$((10#${BASH_REMATCH[2]}))
    local day=$((10#${BASH_REMATCH[3]}))
    local hour=$((10#${BASH_REMATCH[4]}))
    local minute=$((10#${BASH_REMATCH[5]}))
    echo "{\"years\":[${year}],\"months\":[${month}],\"days\":[${day}],\"hours\":[${hour}],\"minutes\":[${minute}]}"
  else
    echo "Error: Invalid datetime: '$dt'. Use ISO 8601: YYYY-MM-DDTHH:MM:SS" >&2; return 1
  fi
}

# ============================================================
# Runner Validation
# ============================================================

validate_runner() {
  local runner="$1"
  for r in "${DEFAULT_RUNNERS[@]}"; do
    [[ "$runner" == "$r" ]] && return 0
  done
  if [[ -f "$RUNNERS_CONF" ]]; then
    while IFS= read -r line; do
      line=$(echo "$line" | sed 's/#.*//' | xargs)
      [[ -z "$line" ]] && continue
      [[ "$runner" == "$line" ]] && return 0
    done < "$RUNNERS_CONF"
  fi
  echo "Error: Runner '${runner}' not in whitelist. Allowed: ${DEFAULT_RUNNERS[*]}" >&2
  echo "Add custom runners to: ${RUNNERS_CONF}" >&2
  return 1
}

# ============================================================
# JobSpec Conversion
# ============================================================

jobspec_to_event() {
  local jobspec="$1"
  local name enabled schedule_type schedule_expr schedule_tz runner timeout_sec retries
  name=$(echo "$jobspec" | jq -r '.name // empty')
  enabled=$(echo "$jobspec" | jq -r 'if .enabled == null then "true" else (.enabled | tostring) end')
  schedule_type=$(echo "$jobspec" | jq -r '.schedule.type // "cron"')
  schedule_expr=$(echo "$jobspec" | jq -r '.schedule.expr // empty')
  schedule_tz=$(echo "$jobspec" | jq -r '.schedule.timezone // "UTC"')
  runner=$(echo "$jobspec" | jq -r '.execution.runner // empty')
  timeout_sec=$(echo "$jobspec" | jq -r '.policy.timeout_sec // 0')
  retries=$(echo "$jobspec" | jq -r '.policy.retries // 0')

  [[ -n "$name" ]] || { echo "Error: JobSpec requires 'name'" >&2; return 1; }
  [[ -n "$runner" ]] || { echo "Error: JobSpec requires 'execution.runner'" >&2; return 1; }
  [[ -n "$schedule_expr" ]] || { echo "Error: JobSpec requires 'schedule.expr'" >&2; return 1; }
  validate_runner "$runner" || return 1

  local script_content
  script_content=$(echo "$jobspec" | jq -r '
    .execution.runner as $runner |
    (.execution.args // []) | map(@sh) | join(" ") |
    if . == "" then "#!/bin/sh\n" + $runner else "#!/bin/sh\n" + $runner + " " + . end
  ')

  local timing
  case "$schedule_type" in
    cron)  timing=$(cron_to_timing "$schedule_expr") || return 1 ;;
    every) timing=$(every_to_timing "$schedule_expr") || return 1 ;;
    once)  timing=$(once_to_timing "$schedule_expr") || return 1 ;;
    *)     die "Unknown schedule type: '$schedule_type'" ;;
  esac

  local target="allgrp"
  local target_hostname
  target_hostname=$(echo "$jobspec" | jq -r '.target.hostname // empty')
  [[ -n "$target_hostname" ]] && target="$target_hostname"

  local enabled_int=1
  [[ "$enabled" == "false" || "$enabled" == "0" ]] && enabled_int=0

  jq -n \
    --arg title "$name" \
    --argjson enabled "$enabled_int" \
    --arg target "$target" \
    --argjson timing "$timing" \
    --arg timezone "$schedule_tz" \
    --argjson timeout "${timeout_sec:-0}" \
    --argjson retries "${retries:-0}" \
    --arg script "$script_content" \
    '{
      title: $title, enabled: $enabled, category: "general",
      plugin: "shellplug", target: $target, timing: $timing,
      timezone: $timezone, timeout: $timeout, retries: $retries,
      params: { script: $script, annotate: 0 }
    }'
}

# ============================================================
# Commands
# ============================================================

cmd_create() {
  local jobspec="${1:?Error: JobSpec JSON required. Usage: cron-agent create '<json>'}"
  echo "$jobspec" | jq empty 2>/dev/null || die "Invalid JSON: $jobspec"
  local event_json
  event_json=$(jobspec_to_event "$jobspec") || return 1
  local result
  result=$(cronicle_api POST "/api/app/create_event/v1" "$event_json") || return 1
  local event_id
  event_id=$(echo "$result" | jq -r '.id // "unknown"')
  echo "Job created. Event ID: ${event_id}"
  echo "$result" | format_json
}

cmd_update() {
  local id="${1:?Error: Job ID required. Usage: cron-agent update <id> '<json>'}"
  local jobspec="${2:?Error: JobSpec JSON required.}"
  echo "$jobspec" | jq empty 2>/dev/null || die "Invalid JSON"

  local update_json
  update_json=$(jq -n --arg id "$id" '{id: $id}')

  local name; name=$(echo "$jobspec" | jq -r '.name // empty')
  [[ -n "$name" ]] && update_json=$(echo "$update_json" | jq --arg t "$name" '. + {title: $t}')

  local enabled; enabled=$(echo "$jobspec" | jq -r '.enabled // empty')
  if [[ -n "$enabled" ]]; then
    if [[ "$enabled" == "true" || "$enabled" == "1" ]]; then
      update_json=$(echo "$update_json" | jq '. + {enabled: 1}')
    else
      update_json=$(echo "$update_json" | jq '. + {enabled: 0}')
    fi
  fi

  local stype sexpr stz
  stype=$(echo "$jobspec" | jq -r '.schedule.type // empty')
  sexpr=$(echo "$jobspec" | jq -r '.schedule.expr // empty')
  stz=$(echo "$jobspec" | jq -r '.schedule.timezone // empty')
  if [[ -n "$sexpr" && -n "$stype" ]]; then
    local timing
    case "$stype" in
      cron)  timing=$(cron_to_timing "$sexpr") || return 1 ;;
      every) timing=$(every_to_timing "$sexpr") || return 1 ;;
      once)  timing=$(once_to_timing "$sexpr") || return 1 ;;
    esac
    update_json=$(echo "$update_json" | jq --argjson t "$timing" '. + {timing: $t}')
  fi
  [[ -n "$stz" ]] && update_json=$(echo "$update_json" | jq --arg tz "$stz" '. + {timezone: $tz}')

  local runner; runner=$(echo "$jobspec" | jq -r '.execution.runner // empty')
  if [[ -n "$runner" ]]; then
    validate_runner "$runner" || return 1
    local script_content
    script_content=$(echo "$jobspec" | jq -r '
      .execution.runner as $runner |
      (.execution.args // []) | map(@sh) | join(" ") |
      if . == "" then "#!/bin/sh\n" + $runner else "#!/bin/sh\n" + $runner + " " + . end
    ')
    update_json=$(echo "$update_json" | jq --arg s "$script_content" '. + {params: {script: $s, annotate: 0}}')
  fi

  local tsec ret
  tsec=$(echo "$jobspec" | jq -r '.policy.timeout_sec // empty')
  ret=$(echo "$jobspec" | jq -r '.policy.retries // empty')
  [[ -n "$tsec" ]] && update_json=$(echo "$update_json" | jq --argjson t "$tsec" '. + {timeout: $t}')
  [[ -n "$ret" ]] && update_json=$(echo "$update_json" | jq --argjson r "$ret" '. + {retries: $r}')

  local result
  result=$(cronicle_api POST "/api/app/update_event/v1" "$update_json") || return 1
  echo "Job updated."
  echo "$result" | format_json
}

cmd_delete() {
  local id="${1:?Error: Job ID required. Usage: cron-agent delete <id>}"
  cronicle_api POST "/api/app/delete_event/v1" "{\"id\":\"${id}\"}" >/dev/null || return 1
  echo "Job deleted: ${id}"
}

cmd_enable() {
  local id="${1:?Error: Job ID required.}"
  cronicle_api POST "/api/app/update_event/v1" "{\"id\":\"${id}\",\"enabled\":1}" >/dev/null || return 1
  echo "Job enabled: ${id}"
}

cmd_disable() {
  local id="${1:?Error: Job ID required.}"
  cronicle_api POST "/api/app/update_event/v1" "{\"id\":\"${id}\",\"enabled\":0}" >/dev/null || return 1
  echo "Job disabled: ${id}"
}

cmd_run() {
  local id="${1:?Error: Job ID required.}"
  local result
  result=$(cronicle_api POST "/api/app/run_event/v1" "{\"id\":\"${id}\"}") || return 1
  local job_ids
  job_ids=$(echo "$result" | jq -r '.ids // [] | join(", ")')
  echo "Job triggered. Execution IDs: ${job_ids}"
  echo "$result" | format_json
}

cmd_list() {
  local limit=50 offset=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)  limit="${2:?}"; shift 2 ;;
      --offset) offset="${2:?}"; shift 2 ;;
      *) die "Unknown flag '$1'" ;;
    esac
  done
  local result
  result=$(cronicle_api GET "/api/app/get_schedule/v1?offset=${offset}&limit=${limit}") || return 1
  echo "$result" | jq -r '
    .rows // [] |
    ["ID", "TITLE", "ENABLED", "CATEGORY", "TARGET"],
    (.[] | [.id, .title, (if .enabled == 1 then "yes" else "no" end), .category, .target]) |
    @tsv
  ' | column -t -s $'\t'
  local total
  total=$(echo "$result" | jq -r '.list.length // 0')
  echo ""
  echo "Total: ${total} jobs (offset=${offset}, limit=${limit})"
}

cmd_get() {
  local id_or_title="${1:?Error: Job ID or title required.}"
  local result
  result=$(cronicle_api GET "/api/app/get_event/v1?id=${id_or_title}" 2>/dev/null) || \
  result=$(cronicle_api GET "/api/app/get_event/v1?title=$(printf '%s' "$id_or_title" | jq -sRr @uri)" 2>/dev/null) || {
    echo "Error: Job not found: ${id_or_title}" >&2; return 1
  }
  echo "$result" | jq '.event'
}

cmd_history() {
  local id="${1:?Error: Job ID required.}"; shift
  local limit=20 offset=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)  limit="${2:?}"; shift 2 ;;
      --offset) offset="${2:?}"; shift 2 ;;
      *) shift ;;
    esac
  done
  local result
  result=$(cronicle_api GET "/api/app/get_event_history/v1?id=${id}&offset=${offset}&limit=${limit}") || return 1
  echo "$result" | jq -r '
    .rows // [] |
    ["JOB_ID", "EVENT_TITLE", "STATUS", "HOSTNAME", "ELAPSED", "CODE"],
    (.[] | [
      .id, .event_title,
      (if .code == 0 then "success" elif .code then "failed(\(.code))" else "running" end),
      .hostname, (.elapsed | tostring | .[0:6] + "s"), (.code // "-" | tostring)
    ]) | @tsv
  ' | column -t -s $'\t'
  local total
  total=$(echo "$result" | jq -r '.list.length // 0')
  echo ""
  echo "Total: ${total} executions"
}

cmd_execution() {
  local id="${1:?Error: Execution/Job ID required.}"
  local result
  result=$(cronicle_api GET "/api/app/get_job_status/v1?id=${id}") || return 1
  echo "$result" | jq '.job'
}

cmd_active() {
  local result
  result=$(cronicle_api GET "/api/app/get_active_jobs/v1") || return 1
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
  # Try unauthenticated ping first (works without API key)
  if curl -sf --max-time 5 "${CRONICLE_URL}/api/app/ping" >/dev/null 2>&1; then
    echo "HEALTHY: Cronicle is running at ${CRONICLE_URL}"
    # If API key is available, also report job count
    if [[ -n "${CRONICLE_API_KEY:-}" ]]; then
      local result
      result=$(curl -sf --max-time 5 "${CRONICLE_URL}/api/app/get_schedule/v1?limit=1" \
        -H "X-API-Key: ${CRONICLE_API_KEY}" 2>/dev/null) || return 0
      local job_count
      job_count=$(echo "$result" | jq -r '.list.length // 0')
      echo "Jobs: ${job_count}"
    fi
    return 0
  fi
  echo "UNHEALTHY: Cannot reach Cronicle at ${CRONICLE_URL}" >&2
  return 1
}

# ============================================================
# Callback Command
# ============================================================

generate_callback_script() {
  local job_name="$1" session_id="$2" script_cmd="$3" prompt="$4"
  local isolated="$5" oc_server_url="$6" oc_auth="$7"

  local agent_script="${OPENDAWG_ROOT}/plugins/opendawg-agent/scripts/opendawg-agent.sh"

  # Phase 2 delivery snippet (inject via HTTP API)
  local phase2_snippet
  phase2_snippet=$(jq -n -r \
    --arg oc_url "$oc_server_url" \
    --arg oc_auth "$oc_auth" \
    '"# Phase 2: Deliver result to session via opencode HTTP API\n" +
     "OPENCODE_URL=" + ($oc_url | @sh) + "\n" +
     "OPENCODE_AUTH=" + ($oc_auth | @sh) + "\n\n" +
     "AUTH_ARGS=()\n" +
     "if [[ -n \"$OPENCODE_AUTH\" ]]; then\n" +
     "  AUTH_ARGS=(-u \"$OPENCODE_AUTH\")\n" +
     "fi\n\n" +
     "echo \"[cron:${JOB_NAME}] Phase 2: Delivering to session ${CALLBACK_SESSION}...\"\n" +
     "HTTP_CODE=$(jq -n --arg text \"$DELIVERY_MSG\" '\''{parts:[{type:\"text\",text:$text}]}'\'' | curl -sf -o /dev/null -w \"%{http_code}\" -X POST -H \"Content-Type: application/json\" \"${AUTH_ARGS[@]+${AUTH_ARGS[@]}}\" --data @- \"${OPENCODE_URL}/session/${CALLBACK_SESSION}/prompt_async\" 2>&1) || {\n" +
     "  echo \"[cron:${JOB_NAME}] ERROR: Delivery failed (HTTP ${HTTP_CODE}).\" >&2\n" +
     "  exit 1\n" +
     "}\n" +
     "echo \"[cron:${JOB_NAME}] Delivered (HTTP ${HTTP_CODE}).\""
  ')

  local cron_script=""

  if [[ -n "$script_cmd" ]]; then
    # Script mode: run shell command, deliver output
    cron_script=$(jq -n -r \
      --arg job_name "$job_name" \
      --arg session "$session_id" \
      --arg cmd "$script_cmd" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\n\n# Phase 1: Execute script\nRESULT_FILE=\"$(mktemp)\"\ntrap '\''rm -f \"$RESULT_FILE\"'\'' EXIT\n\necho \"[cron:${JOB_NAME}] Phase 1: Executing task...\"\nif ( " + $cmd + " ) > \"$RESULT_FILE\" 2>&1; then\n  STATUS=\"completed successfully\"\nelse\n  STATUS=\"completed with errors (exit=$?)\"\nfi\nRESULT=\"$(cat \"$RESULT_FILE\")\"\n\nDELIVERY_MSG=\"[Cron Task: ${JOB_NAME}] ${STATUS}\n\nThis is an automated cron task result. Please summarize and present this to the user.\n\n--- Raw Output ---\n${RESULT}\n--- End Output ---\"\n\n" + $phase2')

  elif [[ "$isolated" == "true" ]]; then
    # Isolated agent mode: run in new session, deliver result
    cron_script=$(jq -n -r \
      --arg job_name "$job_name" \
      --arg session "$session_id" \
      --arg agent "$agent_script" \
      --arg prompt "$prompt" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\nAGENT_SCRIPT=" + ($agent | @sh) +
       "\nPROMPT=" + ($prompt | @sh) +
       "\n\n# Phase 1: Run agent in isolated session\nRESULT_FILE=\"$(mktemp)\"\ntrap '\''rm -f \"$RESULT_FILE\"'\'' EXIT\n\necho \"[cron:${JOB_NAME}] Phase 1: Running isolated agent...\"\nif \"$AGENT_SCRIPT\" \"$PROMPT\" > \"$RESULT_FILE\" 2>&1; then\n  STATUS=\"completed successfully\"\nelse\n  STATUS=\"completed with errors (exit=$?)\"\nfi\nRESULT=\"$(cat \"$RESULT_FILE\")\"\n\nDELIVERY_MSG=\"[Cron Task: ${JOB_NAME}] ${STATUS}\n\nAutomated agent result. Please summarize.\n\n--- Agent Output ---\n${RESULT}\n--- End Output ---\"\n\n" + $phase2')

  else
    # Direct prompt mode: inject prompt as-is
    cron_script=$(jq -n -r \
      --arg job_name "$job_name" \
      --arg session "$session_id" \
      --arg prompt "$prompt" \
      --arg phase2 "$phase2_snippet" \
      '"#!/bin/bash\nset -uo pipefail\nJOB_NAME=" + ($job_name | @sh) +
       "\nCALLBACK_SESSION=" + ($session | @sh) +
       "\n\nDELIVERY_MSG=" + ($prompt | @sh) +
       "\n\n" + $phase2')
  fi

  echo "$cron_script"
}

cmd_callback() {
  local session_id="" schedule_expr="" name="" prompt="" target_host=""
  local schedule_type="" timezone="UTC"
  local script_cmd="" isolated=false
  local oc_server_url="" oc_auth=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session)    session_id="${2:?Error: --session requires a session ID}"; shift 2 ;;
      --schedule)   schedule_expr="${2:?Error: --schedule requires an expression}"; shift 2 ;;
      --name)       name="${2:?}"; shift 2 ;;
      --prompt)     prompt="${2:?}"; shift 2 ;;
      --script)     script_cmd="${2:?}"; shift 2 ;;
      --isolated)   isolated=true; shift ;;
      --host)       target_host="${2:?}"; shift 2 ;;
      --type)       schedule_type="${2:?}"; shift 2 ;;
      --timezone)   timezone="${2:?}"; shift 2 ;;
      --server-url) oc_server_url="${2:?}"; shift 2 ;;
      --auth)       oc_auth="${2:?}"; shift 2 ;;
      *) die "Unknown flag '$1'" ;;
    esac
  done

  [[ -n "$session_id" ]]  || die "--session is required"
  [[ -n "$schedule_expr" ]] || die "--schedule is required"
  [[ -n "$script_cmd" || -n "$prompt" ]] || die "--script or --prompt is required"

  [[ -z "$name" ]] && name="callback-${session_id}"
  [[ -z "$target_host" ]] && target_host="$(hostname)"
  [[ -z "$schedule_type" ]] && schedule_type="$(detect_schedule_type "$schedule_expr")"
  [[ -z "$oc_server_url" ]] && oc_server_url="$OPENCODE_SERVER_URL"
  [[ -z "$oc_auth" ]] && oc_auth="$OPENCODE_AUTH"

  local cron_script
  cron_script=$(generate_callback_script "$name" "$session_id" "$script_cmd" "$prompt" \
    "$isolated" "$oc_server_url" "$oc_auth") || return 1

  local timing
  case "$schedule_type" in
    cron)  timing=$(cron_to_timing "$schedule_expr") || return 1 ;;
    every) timing=$(every_to_timing "$schedule_expr") || return 1 ;;
    once)  timing=$(once_to_timing "$schedule_expr") || return 1 ;;
    *)     die "Unknown schedule type: '$schedule_type'" ;;
  esac

  local event_json
  event_json=$(jq -n \
    --arg title "$name" \
    --arg target "$target_host" \
    --argjson timing "$timing" \
    --arg timezone "$timezone" \
    --arg script "$cron_script" \
    '{
      title: $title, enabled: 1, category: "general",
      plugin: "shellplug", target: $target, timing: $timing,
      timezone: $timezone, timeout: 3600, retries: 0,
      params: { script: $script, annotate: 0 }
    }')

  local mode_desc="direct"
  [[ -n "$script_cmd" ]] && mode_desc="script -> callback"
  [[ "$isolated" == "true" ]] && mode_desc="isolated agent -> callback"

  echo "Creating callback job:"
  echo "  Session:  ${session_id}"
  echo "  Schedule: ${schedule_expr} (${schedule_type})"
  echo "  Target:   ${target_host}"
  echo "  Mode:     ${mode_desc}"
  [[ -n "$script_cmd" ]] && echo "  Script:   ${script_cmd}"
  [[ -n "$prompt" ]] && echo "  Prompt:   ${prompt}"
  echo ""

  local result
  result=$(cronicle_api POST "/api/app/create_event/v1" "$event_json") || return 1
  local event_id
  event_id=$(echo "$result" | jq -r '.id // "unknown"')
  echo "Job created. Event ID: ${event_id}"
  echo "$result" | format_json
}
