# Memory Model (Kiro Runtime)

## Overview

NanoClaw memory is layered. Kiro does not receive memory from one single source; it gets context from SQL prompts, group files, Kiro's own conversation history, and runtime config.

## How Memory Is Provided to Kiro CLI

1. **Prompt memory (immediate context)**
- Host reads pending chat history from SQLite (`getMessagesSince`).
- Messages are formatted and passed as the prompt payload.

2. **Conversation continuation (`--resume`)**
- Host stores a per-group session marker in `sessions` table.
- Runner passes `--resume` when marker exists.
- Kiro continues conversation in the same group working directory context.

3. **Filesystem memory in group workspace**
- Kiro runs with cwd: `groups/<group>/`.
- Files in that folder (including `CLAUDE.md` if present) are available to the agent/tools.

4. **Custom agent memory/prompt**
- Kiro agent definition in `~/.kiro/agents/agent_config.json` contains base prompt, tools, MCP settings, and model defaults.
- NanoClaw ensures `@nanoclaw` MCP access is wired at runtime.

5. **Task history memory**
- `scheduled_tasks` + `task_run_logs` in SQL preserve automation history and outcomes.

## Persistence Layers

### A) Operational SQLite state
- `store/messages.db`
- tables: `messages`, `chats`, `sessions`, `router_state`, `registered_groups`, `scheduled_tasks`, `task_run_logs`

### B) Group files
- `groups/<group>/`
- `groups/<group>/CLAUDE.md` (if used)
- `groups/global/` for shared project files

### C) Kiro local state
- `~/.kiro/agents/agent_config.json` (agent config)
- Kiro’s own support/conversation store (managed by Kiro CLI)

### D) IPC queues
- `data/ipc/<group>/...`
- transient command/message transport between runner and host

## Isolation Model

Isolation key is **group folder**:
- group has its own working directory
- group has its own message cursor in `router_state`
- group has its own session marker in `sessions`
- queue serializes execution per group

## What Survives Restart

Survives:
- `store/messages.db`
- `groups/...` files
- Kiro agent config in `~/.kiro/...`

Does not survive process restart (recomputed/reloaded):
- in-memory maps in `src/index.ts`
- active process handles in group queue

## Practical Checks

```sql
SELECT group_folder, session_id FROM sessions;
SELECT id, group_folder, schedule_type, status, next_run FROM scheduled_tasks ORDER BY created_at DESC;
SELECT task_id, run_at, status FROM task_run_logs ORDER BY run_at DESC LIMIT 20;
```
