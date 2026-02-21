#!/usr/bin/env bash
# ms365-teams-monitor.sh
# Fetches Teams chats + channel messages from the past 30 minutes,
# filters for messages relevant to Hanxiao Du, delivers to opencode session.
# Concurrent requests via background jobs + wait.
set -uo pipefail

MS365_TOKEN_CACHE="${HOME}/.config/ms365-mcp/.token-cache.json"
MS365_ACCOUNT="${HOME}/.config/ms365-mcp/.selected-account.json"
ME="Hanxiao.Du@astratech.ae"
ME_NAME="Hanxiao"
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
TOKEN=$(python3 - <<'PYEOF'
import json, sys, os
path = os.path.expandvars("${HOME}/.config/ms365-mcp/.token-cache.json")
path = os.path.expanduser(path)
data = json.load(open(path))
for entry in data.get("AccessToken", {}).values():
    print(entry["secret"])
    break
PYEOF
)
TOKEN=$(python3 -c "
import json, os
data = json.load(open(os.path.expanduser('$MS365_TOKEN_CACHE')))
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
# Phase 3: Filter relevant messages and format output
# ============================================================
RESULT=$(python3 - <<PYEOF
import json, glob, re, os

me = "$ME"
me_name = "$ME_NAME"
tmpdir = "$TMPDIR_LOCAL"
results = []

for fpath in glob.glob(os.path.join(tmpdir, "*.json")):
    try:
        data = json.load(open(fpath))
    except Exception:
        continue
    for msg in data.get("value", []):
        body_obj = msg.get("body") or {}
        body = body_obj.get("content") or ""
        if not body.strip():
            continue
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

        mentions_upns = [
            (m.get("mentioned") or {}).get("user", {}).get("userPrincipalName", "").lower()
            for m in msg.get("mentions") or []
        ]
        relevant = (
            me.lower() in mentions_upns
            or me_name.lower() in clean_body.lower()
        )
        if not relevant:
            continue

        ch_info = msg.get("channelIdentity") or {}
        ctx = msg.get("chatId") or "team-channel"
        ts = (msg.get("createdDateTime") or "")[:16]
        preview = clean_body[:300].replace("\n", " ")
        results.append(f"[{ts}] {sender_name}: {preview}  (src:{ctx[:50]})")

if results:
    print("\n".join(results))
else:
    print("__NONE__")
PYEOF
)

if [[ "$RESULT" == "__NONE__" ]]; then
  echo "[teams-monitor] No relevant messages in the past ${WINDOW_MINUTES} minutes. Skipping delivery."
  exit 0
fi

echo "[teams-monitor] Found relevant messages, delivering to session..."
echo "=== Teams 相关消息 (过去${WINDOW_MINUTES}分钟) ==="
echo "$RESULT"
