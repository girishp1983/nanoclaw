# NanoClaw Troubleshooting

This guide covers common setup/runtime issues for Kiro-Claw.

## 1) `kiro-cli` Not Found In Service Environment

### Symptom
- Service starts but agent runs fail with messages like:
  - `Failed to start kiro-cli`
  - `spawn kiro-cli ENOENT`

### Why It Happens
- `kiro-cli` is installed in a user-specific directory not present in launchd/systemd `PATH`.
- Interactive shells often have extra path entries, but service managers do not.

### Current Setup Script Behavior
- `./.kiro/skills/setup/scripts/08-setup-service.sh` now auto-detects:
  - `kiro-cli` location via `command -v kiro-cli`
  - `node` location via `command -v node`
- It builds a service `PATH` including:
  - detected `kiro-cli` directory
  - detected `node` directory
  - `~/.local/bin`
  - `~/bin`
  - `~/.bun/bin`
  - `/opt/homebrew/bin`
  - `/usr/local/bin`
  - `/usr/bin`
  - `/bin`

## 2) Manual PATH Fix (macOS launchd)

### Check current plist PATH
```bash
plutil -p ~/Library/LaunchAgents/com.nanoclaw.plist | rg PATH
```

### Re-run setup script (recommended)
```bash
./.kiro/skills/setup/scripts/08-setup-service.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Manual override
```bash
PLIST=~/Library/LaunchAgents/com.nanoclaw.plist
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:PATH /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin" "$PLIST"
launchctl unload "$PLIST"
launchctl load "$PLIST"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 3) Manual PATH Fix (Linux systemd user service)

### Check current unit PATH
```bash
systemctl --user cat nanoclaw | rg '^Environment=PATH='
```

### Re-run setup script (recommended)
```bash
./.kiro/skills/setup/scripts/08-setup-service.sh
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

### Manual override
Edit `~/.config/systemd/user/nanoclaw.service` and set:
```ini
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin:%h/bin:%h/.bun/bin
```
Then:
```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

## 4) WhatsApp Not Responding

### Quick checks
```bash
launchctl list | rg com.nanoclaw
sqlite3 store/messages.db "SELECT jid,name,folder,trigger_pattern,requires_trigger FROM registered_groups;"
tail -n 200 logs/nanoclaw.log
tail -n 200 logs/nanoclaw.error.log
```

### Common causes
- No registered group/JID in `registered_groups`
- Trigger mismatch for non-main groups (`@<assistant_name>`)
- WhatsApp auth expired/missing (`store/auth`)

## 5) Re-authenticate WhatsApp

```bash
npm run auth
```

If auth state is corrupted:
```bash
mv store/auth "store/auth.bak.$(date +%s)"
npm run auth
```

## 6) Verify End-to-End Setup

```bash
./.kiro/skills/setup/scripts/09-verify.sh
```

If failed, inspect:
```bash
tail -n 200 logs/setup.log
tail -n 200 logs/nanoclaw.error.log
```

