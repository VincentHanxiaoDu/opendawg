#!/usr/bin/env bash
# ms365-teams-monitor.sh
# Fetches Teams chats + channel messages from the past 30 minutes.
# Phase 3: uses opencode agent (isolated session) to soft-filter and summarize.
# Only delivers if agent decides there's something worth notifying.
set -uo pipefail

MS365_TOKEN_CACHE="/home/hxd/.config/ms365-mcp/.token-cache.json"
MS365_ACCOUNT="/home/hxd/.config/ms365-mcp/.selected-account.json"
ME="Hanxiao.Du@astratech.ae"
ME_DISPLAY="Hanxiao Du"
WINDOW_MINUTES="${WINDOW_MINUTES:-30}"

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

# --- Refresh / verify token ---
echo "[teams-monitor] Verifying token..."
MS365_MCP_TOKEN_CACHE_PATH="$MS365_TOKEN_CACHE" \
MS365_MCP_SELECTED_ACCOUNT_PATH="$MS365_ACCOUNT" \
  npx -y @softeria/ms-365-mcp-server --org-mode --verify-login >/dev/null 2>&1 || {
  echo "ERROR: ms365 token refresh failed" >&2
  exit 1
}

# --- Extract access token from MSAL cache ---
TOKEN=$(python3 -c "
import json
data = json.load(open('$MS365_TOKEN_CACHE'))
for entry in data.get('AccessToken', {}).values():
    print(entry['secret'])
    break
")

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Could not extract access token" >&2
  exit 1
fi

# --- Time window ---
SINCE=$(python3 -c "
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(minutes=$WINDOW_MINUTES)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")
echo "[teams-monitor] Checking messages since $SINCE"

# --- Graph API helper ---
graph() {
  curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "https://graph.microsoft.com/v1.0/$1"
}

# ============================================================
# Phase 1: Fetch chats list + teams list concurrently
# ============================================================
echo "[teams-monitor] Phase 1: fetching chats and teams list..."

graph "me/chats?\$top=50&\$select=id,topic,chatType" \
  > "$TMPDIR_LOCAL/chats.json" &
graph "me/joinedTeams?\$select=id,displayName" \
  > "$TMPDIR_LOCAL/teams.json" &

wait
echo "[teams-monitor] Phase 1 complete."

# ============================================================
# Phase 2: Fetch messages from all sources concurrently
# ============================================================
echo "[teams-monitor] Phase 2: fetching messages concurrently..."

# 2a. Chat messages (all chats in parallel)
python3 -c "
import json
data = json.load(open('$TMPDIR_LOCAL/chats.json'))
for c in data.get('value', []): print(c['id'])
" 2>/dev/null | while read -r chat_id; do
  safe_id="${chat_id//[^a-zA-Z0-9]/_}"
  graph "chats/${chat_id}/messages?\$top=20&\$filter=lastModifiedDateTime ge ${SINCE}&\$select=id,from,body,mentions,createdDateTime,chatId" \
    > "$TMPDIR_LOCAL/chat_${safe_id}.json" &
done

# 2b. Team channel messages (all teams in parallel, channels within each team in parallel)
python3 -c "
import json
data = json.load(open('$TMPDIR_LOCAL/teams.json'))
for t in data.get('value', []): print(t['id'] + '|' + t['displayName'])
" 2>/dev/null | while IFS="|" read -r team_id team_name; do
  (
    safe_team="${team_id//[^a-zA-Z0-9]/_}"
    channels_json=$(graph "teams/${team_id}/channels?\$select=id,displayName")
    echo "$channels_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for c in data.get('value', []): print(c['id'])
" 2>/dev/null | while read -r ch_id; do
      safe_ch="${ch_id//[^a-zA-Z0-9]/_}"
      graph "teams/${team_id}/channels/${ch_id}/messages?\$top=10&\$filter=lastModifiedDateTime ge ${SINCE}&\$select=id,from,body,mentions,createdDateTime,channelIdentity" \
        > "$TMPDIR_LOCAL/channel_${safe_team}_${safe_ch}.json" &
    done
    wait
  ) &
done

wait
echo "[teams-monitor] Phase 2 complete."

# ============================================================
# Phase 3: Collect all raw messages into a single text dump
# ============================================================
RAW_MESSAGES=$(python3 - <<PYEOF
import json, glob, re, os

me = "$ME"
tmpdir = "$TMPDIR_LOCAL"
results = []

for fpath in sorted(glob.glob(os.path.join(tmpdir, "*.json"))):
    try:
        data = json.load(open(fpath))
    except Exception:
        continue
    for msg in data.get("value", []):
        body_obj = msg.get("body") or {}
        body = body_obj.get("content") or ""
        clean_body = re.sub(r"<[^>]+>", "", body).strip()
        if not clean_body or clean_body in ("null",):
            continue

        sender = msg.get("from") or {}
        user = sender.get("user") or {}
        app = sender.get("application") or {}
        sender_email = user.get("userPrincipalName", "") or ""
        sender_name = user.get("displayName") or app.get("displayName") or "System"

        # Skip own messages
        if me.lower() in sender_email.lower():
            continue

        mentions = [
            (m.get("mentioned") or {}).get("user", {}).get("displayName", "")
            for m in msg.get("mentions") or []
        ]
        ch_info = msg.get("channelIdentity") or {}
        ctx = msg.get("chatId") or f"team-channel"
        ts = (msg.get("createdDateTime") or "")[:16]
        preview = clean_body[:500].replace("\n", " ")
        mention_str = f" [@{', @'.join(m for m in mentions if m)}]" if mentions else ""

        results.append(f"[{ts}] {sender_name}{mention_str}: {preview}  (src:{ctx[:60]})")

if results:
    print("\n".join(results))
else:
    print("__NONE__")
PYEOF
)

if [[ "$RAW_MESSAGES" == "__NONE__" ]]; then
  echo "[teams-monitor] No messages in the past ${WINDOW_MINUTES} minutes. Done."
  exit 0
fi

echo "[teams-monitor] Phase 3: asking agent to filter and summarize..."

# ============================================================
# Phase 4: opencode agent soft-filter (isolated session)
# ============================================================
AGENT_PROMPT="You are a smart notification filter for $ME_DISPLAY ($ME).

Below are Teams messages from the past ${WINDOW_MINUTES} minutes. Your job:
1. Decide if any messages are worth notifying the user about.
2. A message is worth notifying if it: directly mentions or addresses the user, requires a response or action, contains information the user would likely want to know about (decisions, blockers, questions to them, important updates in their projects).
3. Routine automated messages, bot notifications, unrelated chatter, or messages with no actionable relevance should be IGNORED.
4. If NOTHING is worth notifying, output exactly: __NONE__
5. If there ARE relevant messages, output a clean concise summary in Chinese, grouping by topic/chat, highlighting what needs attention. Do NOT output __NONE__ if there are relevant messages.

--- Teams Messages ---
${RAW_MESSAGES}
--- End ---"

AGENT_RESULT=$(opencode run "$AGENT_PROMPT" 2>/dev/null || echo "__AGENT_ERROR__")

if [[ "$AGENT_RESULT" == "__NONE__" ]] || [[ -z "$AGENT_RESULT" ]]; then
  echo "[teams-monitor] Agent decided: nothing worth notifying. Done."
  exit 0
fi

if [[ "$AGENT_RESULT" == "__AGENT_ERROR__" ]]; then
  echo "[teams-monitor] WARNING: agent filter failed, delivering raw messages as fallback."
  echo "=== Teams 消息 (过去${WINDOW_MINUTES}分钟，原始) ==="
  echo "$RAW_MESSAGES"
  exit 0
fi

echo "[teams-monitor] Agent found relevant messages, delivering..."
echo "=== Teams 消息通知 ==="
echo "$AGENT_RESULT"
