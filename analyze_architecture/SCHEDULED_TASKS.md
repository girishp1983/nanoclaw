# Scheduled Tasks (Kiro Runtime)

## Overview

Scheduled tasks are persisted in SQLite and executed by the same host queueing system used for regular message processing.

A task is a row in `scheduled_tasks` with:
- `prompt`
- `schedule_type` (`once`, `cron`, `interval`)
- `schedule_value`
- `next_run`
- `status`
- `context_mode` (`group`, `isolated`)

## Creation Path

1. User asks in WhatsApp.
2. Kiro run calls MCP tool `schedule_task`.
3. MCP writes JSON command to `data/ipc/<group>/tasks/`.
4. `src/ipc.ts` validates auth/schedule and inserts row in SQL.

## Execution Path

1. `startSchedulerLoop` (every 60s) queries due active tasks.
2. Each due task is queued through `GroupQueue`.
3. `runTask(...)` launches `runContainerAgent(...)`.
4. Runner executes `kiro-cli chat ...`.
5. Output delivery:
- direct stream callback -> WhatsApp send
- or MCP `send_message` -> IPC Watcher -> WhatsApp send
6. Run outcome persisted in `task_run_logs`; task row updated via `updateTaskAfterRun`.

## One-Time vs Recurring

### `once`
- executes once
- `next_run` becomes null
- task status transitions to completed

### `cron`/`interval`
- next run is recomputed after each execution
- task remains active unless paused/cancelled

## Controls

Available through MCP/IPC:
- `pause_task`
- `resume_task`
- `cancel_task`
- `list_tasks`

## Context Mode

- `group`: reuse stored group session marker
- `isolated`: no session resume; fresh run context

## Queueing Behavior Note

Tasks are serialized per group. If a long-running task is active, other due tasks for that group wait in queue until the active run completes or exits.

## Quick SQL Checks

```sql
SELECT id, group_folder, schedule_type, schedule_value, status, next_run, last_run
FROM scheduled_tasks
ORDER BY created_at DESC;

SELECT task_id, run_at, status, substr(result,1,120), substr(error,1,120)
FROM task_run_logs
ORDER BY run_at DESC
LIMIT 20;
```
