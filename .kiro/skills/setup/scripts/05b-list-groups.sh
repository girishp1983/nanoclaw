#!/bin/bash
set -euo pipefail

# 05b-list-groups.sh — Query WhatsApp groups from the database.
# Output: pipe-separated JID|name lines, most recent first.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DB_PATH="$PROJECT_ROOT/store/messages.db"

LIMIT="${1:-30}"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: database not found" >&2
  exit 1
fi

# Print duplicate-name warning to stderr (does not affect normal JID|name output)
DUPLICATES=$(sqlite3 "$DB_PATH" "
  SELECT name || ' (count=' || COUNT(*) || ')'
  FROM chats
  WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__' AND name <> jid
  GROUP BY name
  HAVING COUNT(*) > 1
" 2>/dev/null || true)

if [ -n "$DUPLICATES" ]; then
  echo "WARNING: duplicate WhatsApp group names found. Select by JID to avoid ambiguity:" >&2
  echo "$DUPLICATES" >&2
fi

sqlite3 "$DB_PATH" "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND jid <> '__group_sync__' AND name <> jid ORDER BY last_message_time DESC LIMIT $LIMIT"
