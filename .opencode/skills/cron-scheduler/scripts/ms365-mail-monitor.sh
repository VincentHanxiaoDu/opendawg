#!/usr/bin/env bash
# ms365-mail-monitor.sh
# Fetches inbox emails from the past 4 hours (incremental).
# Phase 2: uses opencode agent (isolated session) to soft-filter and summarize.
# Only delivers if agent decides there's something worth notifying.
set -uo pipefail

MS365_TOKEN_CACHE="/home/hxd/.config/ms365-mcp/.token-cache.json"
MS365_ACCOUNT="/home/hxd/.config/ms365-mcp/.selected-account.json"
ME="Hanxiao.Du@astratech.ae"
ME_DISPLAY="Hanxiao Du"
WINDOW_HOURS="${WINDOW_HOURS:-4}"

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

# --- Refresh / verify token ---
echo "[mail-monitor] Verifying token..."
MS365_MCP_TOKEN_CACHE_PATH="$MS365_TOKEN_CACHE" \
MS365_MCP_SELECTED_ACCOUNT_PATH="$MS365_ACCOUNT" \
  npx -y @softeria/ms-365-mcp-server --org-mode --verify-login >/dev/null 2>&1 || {
  echo "ERROR: ms365 token refresh failed" >&2
  exit 1
}

# --- Extract access token ---
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
print((datetime.now(timezone.utc) - timedelta(hours=$WINDOW_HOURS)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")
echo "[mail-monitor] Checking emails since $SINCE"

graph() {
  curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    "https://graph.microsoft.com/v1.0/$1"
}

# ============================================================
# Phase 1: Fetch inbox + mentions + high-importance concurrently
# ============================================================
echo "[mail-monitor] Phase 1: fetching mail concurrently..."

FILTER="receivedDateTime ge $SINCE"
SELECT="id,subject,from,receivedDateTime,isRead,importance,bodyPreview,toRecipients,ccRecipients"

graph "me/mailFolders/inbox/messages?\$filter=${FILTER}&\$select=${SELECT}&\$top=50&\$orderby=receivedDateTime desc" \
  > "$TMPDIR_LOCAL/inbox.json" &

graph "me/messages?\$filter=${FILTER} and mentionsPreview/isMentioned eq true&\$select=${SELECT}&\$top=20" \
  > "$TMPDIR_LOCAL/mentions.json" &

graph "me/messages?\$filter=${FILTER} and importance eq 'high'&\$select=${SELECT}&\$top=20" \
  > "$TMPDIR_LOCAL/important.json" &

wait
echo "[mail-monitor] Phase 1 complete."

# ============================================================
# Phase 2: Collect raw email data (deduped)
# ============================================================
RAW_EMAILS=$(python3 - <<PYEOF
import json, glob, os

tmpdir = "$TMPDIR_LOCAL"
seen_ids = set()
emails = []

priority_tags = {
    "mentions.json": "[MENTIONED]",
    "important.json": "[HIGH IMPORTANCE]",
    "inbox.json": "",
}

for fname, tag in priority_tags.items():
    fpath = os.path.join(tmpdir, fname)
    try:
        data = json.load(open(fpath))
    except Exception:
        continue
    for msg in data.get("value", []):
        mid = msg.get("id", "")
        if mid in seen_ids:
            continue
        seen_ids.add(mid)

        subject = msg.get("subject") or "(no subject)"
        from_obj = (msg.get("from") or {}).get("emailAddress") or {}
        sender_name = from_obj.get("name") or from_obj.get("address") or "Unknown"
        sender_email = from_obj.get("address") or ""
        received = (msg.get("receivedDateTime") or "")[:16]
        is_read = msg.get("isRead", True)
        importance = msg.get("importance", "normal")
        preview = (msg.get("bodyPreview") or "").strip()[:300].replace("\n", " ")

        to_list = [
            (r.get("emailAddress") or {}).get("address", "")
            for r in (msg.get("toRecipients") or [])
        ]
        to_str = ", ".join(to_list[:3]) + ("..." if len(to_list) > 3 else "")

        flags = []
        if tag: flags.append(tag)
        if not is_read: flags.append("UNREAD")
        if importance == "high": flags.append("HIGH-IMPORTANCE")
        flag_str = f" [{', '.join(flags)}]" if flags else ""

        lines = [
            f"[{received}]{flag_str} Subject: {subject}",
            f"  From: {sender_name} <{sender_email}>",
            f"  To:   {to_str}",
        ]
        if preview:
            lines.append(f"  Preview: {preview}")
        emails.append("\n".join(lines))

if emails:
    print("\n\n".join(emails))
else:
    print("__NONE__")
PYEOF
)

if [[ "$RAW_EMAILS" == "__NONE__" ]]; then
  echo "[mail-monitor] No new emails in the past ${WINDOW_HOURS} hours. Done."
  exit 0
fi

echo "[mail-monitor] Phase 2: asking agent to filter and summarize..."

# ============================================================
# Phase 3: opencode agent soft-filter (isolated session)
# ============================================================
AGENT_PROMPT="You are a smart email notification filter for $ME_DISPLAY ($ME).

Below are emails received in the past ${WINDOW_HOURS} hours. Your job:
1. Decide which emails are worth notifying the user about.
2. Worth notifying: emails requiring action or response, important decisions, deadlines, emails directly addressed to the user personally, anything urgent or high-priority.
3. NOT worth notifying: newsletters, automated notifications, CC-only with no action needed, spam, routine status updates the user doesn't need to act on.
4. If NOTHING is worth notifying, output exactly: __NONE__
5. If there ARE relevant emails, output a clean concise summary in Chinese. For each important email, include: sender, subject, key point, and whether action is needed. Group logically if multiple. Do NOT output __NONE__ if there are relevant emails.

--- Emails ---
${RAW_EMAILS}
--- End ---"

AGENT_RESULT=$(opencode run "$AGENT_PROMPT" 2>/dev/null || echo "__AGENT_ERROR__")

if [[ "$AGENT_RESULT" == "__NONE__" ]] || [[ -z "$AGENT_RESULT" ]]; then
  echo "[mail-monitor] Agent decided: nothing worth notifying. Done."
  exit 0
fi

if [[ "$AGENT_RESULT" == "__AGENT_ERROR__" ]]; then
  echo "[mail-monitor] WARNING: agent filter failed, delivering raw emails as fallback."
  echo "=== 邮件增量 (过去${WINDOW_HOURS}小时，原始) ==="
  echo "$RAW_EMAILS"
  exit 0
fi

echo "[mail-monitor] Agent found relevant emails, delivering..."
echo "=== 邮件通知 ==="
echo "$AGENT_RESULT"
