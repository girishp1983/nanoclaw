#!/bin/bash
set -euo pipefail

# 08-setup-service.sh — Generate and load service manager config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [setup-service] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
PLATFORM=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Auto-detect platform
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin*) PLATFORM="macos" ;;
    Linux*)  PLATFORM="linux" ;;
    *)       PLATFORM="unknown" ;;
  esac
fi

NODE_PATH="$(command -v node || true)"
PROJECT_PATH="$PROJECT_ROOT"
HOME_PATH="$HOME"
KIRO_CLI_PATH="$(command -v kiro-cli || true)"
KIRO_CLI_DIR=""
if [ -n "$KIRO_CLI_PATH" ]; then
  KIRO_CLI_DIR="$(dirname "$KIRO_CLI_PATH")"
fi

SERVICE_PATH=""
append_path() {
  local dir="$1"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    return
  fi
  case ":$SERVICE_PATH:" in
    *":$dir:"*) ;;
    *)
      if [ -z "$SERVICE_PATH" ]; then
        SERVICE_PATH="$dir"
      else
        SERVICE_PATH="$SERVICE_PATH:$dir"
      fi
      ;;
  esac
}

# Build service PATH in priority order.
# Include detected kiro-cli/node locations and common user/system bin directories.
append_path "$KIRO_CLI_DIR"
if [ -n "$NODE_PATH" ]; then
  append_path "$(dirname "$NODE_PATH")"
fi
append_path "$HOME_PATH/.local/bin"
append_path "$HOME_PATH/bin"
append_path "$HOME_PATH/.bun/bin"
append_path "/opt/homebrew/bin"
append_path "/usr/local/bin"
append_path "/usr/bin"
append_path "/bin"

log "Setting up service: platform=$PLATFORM node=$NODE_PATH kiro=$KIRO_CLI_PATH project=$PROJECT_PATH"
log "Computed service PATH: $SERVICE_PATH"

if [ -z "$NODE_PATH" ]; then
  log "Node binary not found in current shell"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: unknown
NODE_PATH: not_found
KIRO_CLI_PATH: ${KIRO_CLI_PATH:-not_found}
SERVICE_PATH: $SERVICE_PATH
PROJECT_PATH: $PROJECT_PATH
STATUS: failed
ERROR: node_not_found
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Build first
log "Building TypeScript"
if ! npm run build >> "$LOG_FILE" 2>&1; then
  log "Build failed"
  cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: unknown
NODE_PATH: $NODE_PATH
KIRO_CLI_PATH: ${KIRO_CLI_PATH:-not_found}
SERVICE_PATH: $SERVICE_PATH
PROJECT_PATH: $PROJECT_PATH
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Create logs directory
mkdir -p "$PROJECT_PATH/logs"

case "$PLATFORM" in

  macos)
    PLIST_PATH="$HOME_PATH/Library/LaunchAgents/com.nanoclaw.plist"
    log "Generating launchd plist at $PLIST_PATH"

    mkdir -p "$HOME_PATH/Library/LaunchAgents"

    cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${SERVICE_PATH}</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLISTEOF

    log "Loading launchd service"
    if launchctl load "$PLIST_PATH" >> "$LOG_FILE" 2>&1; then
      log "launchctl load succeeded"
    else
      log "launchctl load failed (may already be loaded)"
    fi

    # Verify
    SERVICE_LOADED="false"
    if launchctl list 2>/dev/null | grep -q "com.nanoclaw"; then
      SERVICE_LOADED="true"
      log "Service verified as loaded"
    else
      log "Service not found in launchctl list"
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: launchd
NODE_PATH: $NODE_PATH
KIRO_CLI_PATH: ${KIRO_CLI_PATH:-not_found}
SERVICE_PATH: $SERVICE_PATH
PROJECT_PATH: $PROJECT_PATH
PLIST_PATH: $PLIST_PATH
SERVICE_LOADED: $SERVICE_LOADED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
    ;;

  linux)
    UNIT_DIR="$HOME_PATH/.config/systemd/user"
    UNIT_PATH="$UNIT_DIR/nanoclaw.service"
    mkdir -p "$UNIT_DIR"
    log "Generating systemd unit at $UNIT_PATH"

    cat > "$UNIT_PATH" <<UNITEOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${NODE_PATH} ${PROJECT_PATH}/dist/index.js
WorkingDirectory=${PROJECT_PATH}
Restart=always
RestartSec=5
Environment=HOME=${HOME_PATH}
Environment=PATH=${SERVICE_PATH}
StandardOutput=append:${PROJECT_PATH}/logs/nanoclaw.log
StandardError=append:${PROJECT_PATH}/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
UNITEOF

    log "Enabling and starting systemd service"
    systemctl --user daemon-reload >> "$LOG_FILE" 2>&1 || true
    systemctl --user enable nanoclaw >> "$LOG_FILE" 2>&1 || true
    systemctl --user start nanoclaw >> "$LOG_FILE" 2>&1 || true

    # Verify
    SERVICE_LOADED="false"
    if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
      SERVICE_LOADED="true"
      log "Service verified as active"
    else
      log "Service not active"
    fi

    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: systemd
NODE_PATH: $NODE_PATH
KIRO_CLI_PATH: ${KIRO_CLI_PATH:-not_found}
SERVICE_PATH: $SERVICE_PATH
PROJECT_PATH: $PROJECT_PATH
UNIT_PATH: $UNIT_PATH
SERVICE_LOADED: $SERVICE_LOADED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
    ;;

  *)
    log "Unsupported platform: $PLATFORM"
    cat <<EOF
=== NANOCLAW SETUP: SETUP_SERVICE ===
SERVICE_TYPE: unknown
NODE_PATH: $NODE_PATH
KIRO_CLI_PATH: ${KIRO_CLI_PATH:-not_found}
SERVICE_PATH: $SERVICE_PATH
PROJECT_PATH: $PROJECT_PATH
STATUS: failed
ERROR: unsupported_platform
LOG: logs/setup.log
=== END ===
EOF
    exit 1
    ;;
esac
