#!/usr/bin/env bash
# ms365-mail-monitor.sh
# Fetches inbox emails from the past 4 hours (incremental),
# concurrent parallel fetches for inbox + other folders.
# Delivers summary to opencode session.
set -uo pipefail

MS365_TOKEN_CACHE="${HOME}/.config/ms365-mcp/.token-cache.json"
MS365_ACCOUNT="${HOME}/.config/ms365-mcp/.selected-account.json"
ME="Hanxiao.Du@astratech.ae"
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
# Phase 1: Fetch inbox + sent + other concurrently
# ============================================================
echo "[mail-monitor] Phase 1: fetching mail folders concurrently..."

FILTER="receivedDateTime ge $SINCE"
SELECT="id,subject,from,receivedDateTime,isRead,importance,bodyPreview,toRecipients,ccRecipients"

# Inbox
graph "me/mailFolders/inbox/messages?\$filter=${FILTER}&\$select=${SELECT}&\$top=50&\$orderby=receivedDateTime desc" \
  > "$TMPDIR_LOCAL/inbox.json" &

# Focused inbox (if enabled)
graph "me/mailFolders/inbox/messages?\$filter=${FILTER} and inferenceClassification eq 'focused'&\$select=${SELECT}&\$top=20" \
  > "$TMPDIR_LOCAL/focused.json" &

# Mentions - messages where I'm mentioned
graph "me/messages?\$filter=${FILTER} and mentionsPreview/isMentioned eq true&\$select=${SELECT}&\$top=20" \
  > "$TMPDIR_LOCAL/mentions.json" &

# High importance
graph "me/messages?\$filter=${FILTER} and importance eq 'high'&\$select=${SELECT}&\$top=20" \
  > "$TMPDIR_LOCAL/important.json" &

wait
echo "[mail-monitor] Phase 1 complete."

# ============================================================
# Phase 2: Deduplicate, format, and summarize
# ============================================================
RESULT=$(python3 - <<PYEOF
import json, glob, os
from datetime import datetime, timezone

window_hours = $WINDOW_HOURS
tmpdir = "$TMPDIR_LOCAL"
seen_ids = set()
emails = []

priority_tags = {
    "mentions.json": "[MENTIONED]",
    "important.json": "[HIGH IMPORTANCE]",
    "focused.json": "[FOCUSED]",
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
        preview = (msg.get("bodyPreview") or "").strip()[:200].replace("\n", " ")

        to_list = [
            (r.get("emailAddress") or {}).get("address", "")
            for r in (msg.get("toRecipients") or [])
        ]
        cc_list = [
            (r.get("emailAddress") or {}).get("address", "")
            for r in (msg.get("ccRecipients") or [])
        ]

        unread_mark = "🔵" if not is_read else "  "
        label = tag if tag else ("[UNREAD]" if not is_read else "")
        to_str = ", ".join(to_list[:3]) + ("..." if len(to_list) > 3 else "")

        lines = [
            f"{unread_mark} {label} [{received}] {subject}",
            f"   From: {sender_name} <{sender_email}>",
            f"   To:   {to_str}",
        ]
        if preview:
            lines.append(f"   Preview: {preview}")
        emails.append("\n".join(lines))

if emails:
    print(f"共 {len(emails)} 封新邮件 (过去{window_hours}小时)\n")
    print("\n\n".join(emails))
else:
    print("__NONE__")
PYEOF
)

if [[ "$RESULT" == "__NONE__" ]]; then
  echo "[mail-monitor] No new emails in the past ${WINDOW_HOURS} hours. Skipping delivery."
  exit 0
fi

echo "[mail-monitor] Found new emails, delivering to session..."
echo "=== 邮件增量报告 (过去${WINDOW_HOURS}小时) ==="
echo "$RESULT"
