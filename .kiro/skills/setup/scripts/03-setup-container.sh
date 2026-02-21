#!/bin/bash
set -euo pipefail

# 03-setup-container.sh — Build Docker image and verify container runtime tools

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-container] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

IMAGE="${NANOCLAW_AGENT_IMAGE:-nanoclaw-agent:latest}"

BUILD_OK="false"
IMAGE_OK="false"
DOCKER="not_running"
ERROR=""

log "Starting container setup for image $IMAGE"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER="running"
  log "Docker is running"
else
  ERROR="docker_not_running"
  log "Docker is not running"
fi

# Build host TypeScript first (service process)
if [ -z "$ERROR" ]; then
  log "Running npm run build"
  if npm run build >> "$LOG_FILE" 2>&1; then
    log "Host build succeeded"
  else
    ERROR="host_build_failed"
    log "Host build failed"
  fi
fi

# Build container image
if [ -z "$ERROR" ]; then
  log "Building Docker image $IMAGE"
  if docker build -t "$IMAGE" "$PROJECT_ROOT/container" >> "$LOG_FILE" 2>&1; then
    BUILD_OK="true"
    log "Docker image build succeeded"
  else
    ERROR="image_build_failed"
    log "Docker image build failed"
  fi
fi

# Verify kiro-cli is available in container image
if [ "$BUILD_OK" = "true" ]; then
  log "Verifying kiro-cli inside container image"
  if docker run --rm --entrypoint /bin/sh "$IMAGE" -lc "kiro-cli --version >/dev/null 2>&1" >> "$LOG_FILE" 2>&1; then
    IMAGE_OK="true"
    log "kiro-cli found in container image"
  else
    ERROR="kiro_cli_missing_in_image"
    log "kiro-cli missing in container image"
  fi
fi

STATUS="success"
if [ "$BUILD_OK" != "true" ] || [ "$IMAGE_OK" != "true" ]; then
  STATUS="failed"
fi

cat <<EOF_STATUS
=== NANOCLAW SETUP: SETUP_CONTAINER ===
RUNTIME: docker
IMAGE: $IMAGE
DOCKER: $DOCKER
BUILD_OK: $BUILD_OK
IMAGE_OK: $IMAGE_OK
STATUS: $STATUS
ERROR: ${ERROR:-none}
LOG: logs/setup.log
=== END ===
EOF_STATUS

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
