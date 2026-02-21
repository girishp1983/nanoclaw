#!/bin/bash
set -euo pipefail

# 03-setup-runtime.sh — Host runtime readiness check (no container build)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-runtime] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Ignore any legacy args like --runtime for backward compatibility
while [[ $# -gt 0 ]]; do
  shift
done

BUILD_OK="false"
KIRO_CLI="missing"
AGENT_CONFIG="missing"

log "Checking host runtime readiness"

# 1) Build TypeScript
log "Running npm run build"
if npm run build >> "$LOG_FILE" 2>&1; then
  BUILD_OK="true"
  log "Build succeeded"
else
  log "Build failed"
fi

# 2) Check kiro-cli availability
if command -v kiro-cli >/dev/null 2>&1; then
  KIRO_CLI="available"
  log "kiro-cli found: $(command -v kiro-cli)"
else
  log "kiro-cli missing"
fi

# 3) Check agent config
if [ -f "$HOME/.kiro/agents/agent_config.json" ]; then
  AGENT_CONFIG="found"
  log "Kiro agent config found"
else
  log "Kiro agent config missing"
fi

STATUS="success"
ERROR=""
if [ "$BUILD_OK" != "true" ]; then
  STATUS="failed"
  ERROR="build_failed"
elif [ "$KIRO_CLI" != "available" ]; then
  STATUS="failed"
  ERROR="kiro_cli_missing"
elif [ "$AGENT_CONFIG" != "found" ]; then
  STATUS="failed"
  ERROR="agent_config_missing"
fi

cat <<EOF_STATUS
=== NANOCLAW SETUP: SETUP_RUNTIME ===
BUILD_OK: $BUILD_OK
KIRO_CLI: $KIRO_CLI
KIRO_AGENT_CONFIG: $AGENT_CONFIG
STATUS: $STATUS
ERROR: ${ERROR:-none}
LOG: logs/setup.log
=== END ===
EOF_STATUS

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
