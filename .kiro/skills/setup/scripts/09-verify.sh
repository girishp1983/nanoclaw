#!/bin/bash
set -euo pipefail

# 09-verify.sh — End-to-end health check for Docker Desktop container deployment

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [verify] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "Starting verification"

IMAGE="${NANOCLAW_AGENT_IMAGE:-nanoclaw-agent:latest}"

# Detect platform
case "$(uname -s)" in
  Darwin*) PLATFORM="macos" ;;
  Linux*)  PLATFORM="linux" ;;
  *)       PLATFORM="unknown" ;;
esac

# 1. Check service status
SERVICE="not_found"
if [ "$PLATFORM" = "macos" ]; then
  if launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
    LAUNCHCTL_LINE=$(launchctl list 2>/dev/null | grep "com.nanoclaw" || true)
    PID_FIELD=$(echo "$LAUNCHCTL_LINE" | awk '{print $1}')
    if [ "$PID_FIELD" != "-" ] && [ -n "$PID_FIELD" ]; then
      SERVICE="running"
    else
      SERVICE="stopped"
    fi
  fi
elif [ "$PLATFORM" = "linux" ]; then
  if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
    SERVICE="running"
  elif systemctl --user list-unit-files 2>/dev/null | grep -q "nanoclaw"; then
    SERVICE="stopped"
  fi
fi
log "Service: $SERVICE"

# 2. Check Docker
DOCKER="not_running"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER="running"
fi
log "Docker: $DOCKER"

# 3. Check container image
AGENT_IMAGE="missing"
if [ "$DOCKER" = "running" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  AGENT_IMAGE="available"
fi
log "Agent image ($IMAGE): $AGENT_IMAGE"

# 4. Check Kiro agent config (mounted into container)
KIRO_AGENT_CONFIG="missing"
if [ -f "$HOME/.kiro/agents/agent_config.json" ]; then
  KIRO_AGENT_CONFIG="found"
fi
log "Kiro agent config: $KIRO_AGENT_CONFIG"

# 5. Check WhatsApp auth
WHATSAPP_AUTH="not_found"
if [ -d "$PROJECT_ROOT/store/auth" ] && [ "$(ls -A "$PROJECT_ROOT/store/auth" 2>/dev/null)" ]; then
  WHATSAPP_AUTH="authenticated"
fi
log "WhatsApp auth: $WHATSAPP_AUTH"

# 6. Check registered groups (in SQLite)
REGISTERED_GROUPS=0
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  REGISTERED_GROUPS=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM registered_groups" 2>/dev/null || echo "0")
fi
log "Registered groups: $REGISTERED_GROUPS"

# 7. Check mount allowlist
MOUNT_ALLOWLIST="missing"
if [ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]; then
  MOUNT_ALLOWLIST="configured"
fi
log "Mount allowlist: $MOUNT_ALLOWLIST"

# Determine overall status
STATUS="success"
if [ "$SERVICE" != "running" ] || [ "$DOCKER" != "running" ] || [ "$AGENT_IMAGE" != "available" ] || [ "$KIRO_AGENT_CONFIG" != "found" ] || [ "$WHATSAPP_AUTH" = "not_found" ] || [ "$REGISTERED_GROUPS" -eq 0 ] 2>/dev/null; then
  STATUS="failed"
fi

log "Verification complete: $STATUS"

cat <<EOF_STATUS
=== NANOCLAW SETUP: VERIFY ===
SERVICE: $SERVICE
DOCKER: $DOCKER
AGENT_IMAGE: $AGENT_IMAGE
IMAGE_NAME: $IMAGE
KIRO_AGENT_CONFIG: $KIRO_AGENT_CONFIG
WHATSAPP_AUTH: $WHATSAPP_AUTH
REGISTERED_GROUPS: $REGISTERED_GROUPS
MOUNT_ALLOWLIST: $MOUNT_ALLOWLIST
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF_STATUS

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
