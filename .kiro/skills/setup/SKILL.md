---
name: setup
description: Run initial Kiro-Claw setup. Use when user wants to install dependencies, authenticate WhatsApp, build the Docker agent image, register their main channel, or start background services. Triggers on "setup", "install", "configure Kiro-claw", or first-time setup requests.
---

# Kiro-claw Setup (Docker Desktop + Kiro CLI)

Run setup scripts automatically. Pause only when user action is required (WhatsApp authentication, choosing channel, confirming paths). Scripts live in `.kiro/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** If something is broken or missing, fix it. Only ask the user to do steps that require human interaction.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Check Environment

Run `./.kiro/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_AUTH=true: note WhatsApp auth exists and offer to keep it.
- If HAS_REGISTERED_GROUPS=true: note existing group config and offer to keep or reconfigure.
- Record PLATFORM, NODE_OK, DOCKER, and KIRO_AGENT_CONFIG.

**If NODE_OK=false:**

Install Node.js 22 and re-run the environment check.

- macOS: `brew install node@22` (or install nvm then `nvm install 22`)
- Linux: NodeSource or nvm

**If DOCKER is not running:**

Start Docker Desktop (or Docker daemon on Linux), then re-run step 1.

**If KIRO_AGENT_CONFIG=missing:**

Tell the user to create `~/.kiro/agents/agent_config.json` for their custom agent profile, then re-run step 1.

## 2. Install Dependencies

Run `./.kiro/skills/setup/scripts/02-install-deps.sh` and parse the status block.

If failed:

1. Read the tail of `logs/setup.log`
2. Retry after cleaning `node_modules` and `package-lock.json`
3. Install build tools if native modules fail (e.g. `xcode-select --install`, `build-essential`)

Only escalate to user help after repeated failures.

## 3. Container Runtime Readiness (Docker)

Run `./.kiro/skills/setup/scripts/03-setup-container.sh` and parse the status block.

This script verifies container runtime prerequisites and image health:

- Docker daemon is running
- `npm run build` succeeds for host service code
- Docker image `nanoclaw-agent:latest` builds successfully
- `kiro-cli` is available inside the image

If any check fails, fix and re-run step 3.

## 4. WhatsApp Authentication

If HAS_AUTH=true from step 1, confirm whether to keep existing auth or re-authenticate.

AskUserQuestion: QR in browser (recommended) vs pairing code vs QR in terminal?

- QR browser: `./.kiro/skills/setup/scripts/04-auth-whatsapp.sh --method qr-browser`
- Pairing code: `./.kiro/skills/setup/scripts/04-auth-whatsapp.sh --method pairing-code --phone NUMBER`
- QR terminal: `./.kiro/skills/setup/scripts/04-auth-whatsapp.sh --method qr-terminal`

Handle failures by re-running auth and regenerating QR/pairing code.

## 5. Configure Trigger and Channel Type

Get bot phone number from auth credentials:

`node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion:

- Does bot share your personal number or use a dedicated number?
- What trigger word? (default `Andy`)
- Main channel type (DM/self-chat/solo group based on number setup)

In group chats, messages prefixed with `@TriggerWord` route to the agent. In the main channel, prefix is usually not required.

## 6. Sync and Select Group (If Group Channel)

For personal chat or DM, construct JID as `NUMBER@s.whatsapp.net`.

For group channels:

1. Run `./.kiro/skills/setup/scripts/05-sync-groups.sh`
2. If build fails, fix TypeScript errors and retry
3. If GROUPS_IN_DB=0, inspect logs and re-run sync after fixing auth/connection
4. Run `./.kiro/skills/setup/scripts/05b-list-groups.sh`
5. Present likely matches by group name (not JID) and allow Other

## 7. Register Channel

Run `./.kiro/skills/setup/scripts/06-register-channel.sh`:

- `--jid "JID"`
- `--name "main"`
- `--trigger "@TriggerWord"`
- `--folder "main"`
- `--no-trigger-required` for personal chat/DM/solo chat flows

## 7b. Change to a New WhatsApp Group (Reconfiguration)

Use this flow when the user says they want to move Kiro-Claw to a different group.

1. Refresh groups: `./.kiro/skills/setup/scripts/05-sync-groups.sh`
2. List groups: `./.kiro/skills/setup/scripts/05b-list-groups.sh 50`
3. Ask the user which group to switch to (by group name), then capture its JID.
4. Re-register `main` with the new JID:

`./.kiro/skills/setup/scripts/06-register-channel.sh --jid "NEW_GROUP_JID@g.us" --name "main" --trigger "@TriggerWord" --folder "main"`

5. Restart service so in-memory routing reloads:

- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`

6. Verify mapping:

`sqlite3 store/messages.db "SELECT jid,name,folder,trigger_pattern,requires_trigger FROM registered_groups;"`

Notes:

- Keep `--folder "main"` when replacing the main group.
- Group JIDs end with `@g.us`; DM JIDs end with `@s.whatsapp.net`.

## 8. Mount Allowlist

Ask if agent should access directories outside Kiro-claw.

- If no: `./.kiro/skills/setup/scripts/07-configure-mounts.sh --empty`
- If yes: pass JSON config through stdin to `07-configure-mounts.sh`

## 9. Start Service

If already running, unload/restart cleanly first.

Run `./.kiro/skills/setup/scripts/08-setup-service.sh` and parse status block.

If service load fails:

- Read `logs/setup.log`
- Check `logs/nanoclaw.error.log`
- On macOS check `launchctl list | grep nanoclaw`
- On Linux check `systemctl --user status nanoclaw`

Fix and re-run step 9.

## 10. Verify

Run `./.kiro/skills/setup/scripts/09-verify.sh` and parse status block.

If STATUS=failed, fix each failing component:

- SERVICE not running: build and restart service
- DOCKER not running: start Docker Desktop/daemon
- AGENT_IMAGE missing: re-run step 3 (`03-setup-container.sh`)
- KIRO_AGENT_CONFIG missing: create or fix `~/.kiro/agents/agent_config.json`
- WHATSAPP_AUTH not found: re-run step 4
- REGISTERED_GROUPS=0: re-run steps 6-7
- MOUNT_ALLOWLIST missing: create default via step 8

Re-run `09-verify.sh` until all checks pass.

Then instruct user to test by sending a message in the registered channel.

Log tail command:

`tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:**

- Check `logs/nanoclaw.error.log`
- Re-run setup-service to refresh launchd/systemd config

**No response to messages:**

- Check trigger pattern and registered JID:
  `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Check `logs/nanoclaw.log` and `groups/main/logs/agent-*.log`
- Verify Docker/image health:
  `docker info`
  `docker image inspect nanoclaw-agent:latest`

**WhatsApp disconnected:**

- Re-authenticate: `npm run auth`
- Rebuild/restart service

**Unload service (macOS):**

`launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
