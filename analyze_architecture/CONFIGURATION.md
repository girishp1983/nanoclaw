# NanoClaw Configuration (Kiro Runtime)

This document describes configuration/state when NanoClaw runs with **Kiro CLI + custom Kiro agent**.

## Primary Config Locations

- Project root config:
  - `.env`
- WhatsApp auth store:
  - `store/auth/`
- Operational DB:
  - `store/messages.db`
- Group files:
  - `groups/<group>/`
- Kiro custom agent config:
  - `~/.kiro/agents/agent_config.json`
- Kiro skills:
  - `~/.kiro/skills/`

## Kiro Agent Configuration

NanoClaw expects a custom Kiro agent, for example:
- `name: "kiro-assistant"`

Runtime behavior in `container/agent-runner/src/index.ts`:
1. Reads `~/.kiro/agents/agent_config.json`
2. Resolves agent name (or uses `KIRO_AGENT_NAME`)
3. Ensures `nanoclaw` MCP server entry exists
4. Ensures `@nanoclaw` appears in `tools` and `allowedTools`

This lets Kiro call NanoClaw MCP tools (message/task operations).

## Environment Variables

Important variables:
- `ASSISTANT_NAME`: trigger name used in routing
- `KIRO_AGENT_NAME`: optional override for Kiro agent name
- `KIRO_MODEL`: optional model override
- `TZ`: timezone for scheduler parsing

Runtime vars passed by host to agent-runner include:
- `NANOCLAW_GROUP_DIR`
- `NANOCLAW_IPC_DIR`
- `NANOCLAW_GLOBAL_DIR`
- `NANOCLAW_EXTRA_DIR`
- `NANOCLAW_REAL_HOME`

## SQLite State

DB file:
- `store/messages.db`

Main tables:
- `messages`
- `chats`
- `registered_groups`
- `router_state`
- `sessions`
- `scheduled_tasks`
- `task_run_logs`

## IPC Paths

Per group:
- `data/ipc/<group>/messages/`
- `data/ipc/<group>/tasks/`
- `data/ipc/<group>/input/`

Usage:
- Kiro MCP tool writes JSON commands into `messages/` and `tasks/`
- Host `IPC Watcher` consumes and applies those commands

## Group Scope

- `main` is the control group (`MAIN_GROUP_FOLDER`)
- Non-main groups are scoped to their own JID/folder
- Main can perform cross-group administrative operations

## Service Config

macOS launchd:
- Installed plist: `~/Library/LaunchAgents/com.nanoclaw.plist`
- Logs:
  - `logs/nanoclaw.log`
  - `logs/nanoclaw.error.log`

## Practical Checks

```bash
# list registered groups
sqlite3 store/messages.db "SELECT jid,name,folder,trigger_pattern FROM registered_groups;"

# list sessions
sqlite3 store/messages.db "SELECT group_folder,session_id FROM sessions;"

# inspect tasks
sqlite3 store/messages.db "SELECT id,group_folder,schedule_type,status,next_run FROM scheduled_tasks ORDER BY created_at DESC;"
```
