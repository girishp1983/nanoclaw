#!/bin/bash
set -euo pipefail

# 06-register-channel.sh — Write channel registration config and create group folders

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [register-channel] $*" >> "$LOG_FILE"; }

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

cd "$PROJECT_ROOT"

# Parse args
JID=""
NAME=""
TRIGGER=""
FOLDER=""
REQUIRES_TRIGGER="true"
ASSISTANT_NAME="Andy"

while [[ $# -gt 0 ]]; do
  case $1 in
    --jid)              JID="$2"; shift 2 ;;
    --name)             NAME="$2"; shift 2 ;;
    --trigger)          TRIGGER="$2"; shift 2 ;;
    --folder)           FOLDER="$2"; shift 2 ;;
    --no-trigger-required) REQUIRES_TRIGGER="false"; shift ;;
    --assistant-name)   ASSISTANT_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate required args
if [ -z "$JID" ] || [ -z "$NAME" ] || [ -z "$TRIGGER" ] || [ -z "$FOLDER" ]; then
  log "ERROR: Missing required args (--jid, --name, --trigger, --folder)"
  cat <<EOF_STATUS
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
STATUS: failed
ERROR: missing_required_args
LOG: logs/setup.log
=== END ===
EOF_STATUS
  exit 4
fi

log "Registering channel: jid=$JID name=$NAME trigger=$TRIGGER folder=$FOLDER requiresTrigger=$REQUIRES_TRIGGER"

# Create data directory
mkdir -p "$PROJECT_ROOT/data"
mkdir -p "$PROJECT_ROOT/store"

# Write directly to SQLite
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
DB_PATH="$PROJECT_ROOT/store/messages.db"
REQUIRES_TRIGGER_INT=$( [ "$REQUIRES_TRIGGER" = "true" ] && echo 1 || echo 0 )

JID_SQL=$(sql_escape "$JID")
NAME_SQL=$(sql_escape "$NAME")
FOLDER_SQL=$(sql_escape "$FOLDER")
TRIGGER_SQL=$(sql_escape "$TRIGGER")
TIMESTAMP_SQL=$(sql_escape "$TIMESTAMP")

sqlite3 "$DB_PATH" "
CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1
);
INSERT OR REPLACE INTO registered_groups (
  jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger
) VALUES (
  '$JID_SQL', '$NAME_SQL', '$FOLDER_SQL', '$TRIGGER_SQL', '$TIMESTAMP_SQL', NULL, $REQUIRES_TRIGGER_INT
);
"

log "Wrote registration to SQLite"

# Create group folders
mkdir -p "$PROJECT_ROOT/groups/$FOLDER/logs"
log "Created groups/$FOLDER/logs/"

# Keep assistant-name arg for backwards compatibility; steering content is managed separately.
ASSISTANT_NAME_APPLIED="false"
if [ "$ASSISTANT_NAME" != "Andy" ]; then
  log "Assistant name override provided ($ASSISTANT_NAME); steering content is managed separately"
fi

cat <<EOF_STATUS
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
JID: $JID
NAME: $NAME
FOLDER: $FOLDER
TRIGGER: $TRIGGER
REQUIRES_TRIGGER: $REQUIRES_TRIGGER
ASSISTANT_NAME: $ASSISTANT_NAME
ASSISTANT_NAME_APPLIED: $ASSISTANT_NAME_APPLIED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF_STATUS
