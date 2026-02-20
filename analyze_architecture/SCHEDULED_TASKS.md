# Scheduled Tasks

## Overview
NanoClaw scheduled tasks are persisted in SQLite and executed by a polling scheduler loop.

A scheduled task is a row in `scheduled_tasks` (inside `store/messages.db`) with:
- what to run (`prompt`)
- when to run (`schedule_type`, `schedule_value`, `next_run`)
- where to send output (`chat_jid`, `group_folder`)
- execution state (`status`, `last_run`, `last_result`)
- context behavior (`context_mode`: `group` or `isolated`)

## Where tasks are stored

- Database file: `store/messages.db`
- Task table: `scheduled_tasks`
- Run history table: `task_run_logs`

Schema source: `src/db.ts`.

## How tasks are created

### Path A: from user query (normal path)

1. User asks in WhatsApp for a timed/recurring action.
2. Host runs agent for that conversation.
3. Agent calls MCP tool `schedule_task`.
4. MCP writes a JSON command file into `data/ipc/<group>/tasks/`.
5. `IPC Watcher` (`src/ipc.ts`) reads the file, validates permissions/schedule, computes `next_run`, and calls `createTask(...)`.
6. Task row is inserted into `scheduled_tasks` with `status='active'`.

### Path B: manual DB insert/update (advanced)

You can manually insert/update rows in `scheduled_tasks`, but this bypasses normal validation and is not recommended for day-to-day use.

## Schedule types

Supported schedule types:
- `once`: one-time execution
- `cron`: recurring cron expression
- `interval`: recurring every N milliseconds

Validation/computation logic lives in `src/ipc.ts`:
- `cron`: parsed with `cron-parser` using configured timezone
- `interval`: positive integer milliseconds
- `once`: valid timestamp

## One-time vs recurring behavior

### One-time (`schedule_type='once'`)

- `next_run` is set to the scheduled timestamp when created.
- Scheduler runs it once when due.
- After execution, `next_run` becomes `null`.
- `updateTaskAfterRun(...)` marks task `completed` when `next_run` is `null`.

### Recurring (`cron` or `interval`)

- `next_run` is computed at creation time.
- After every run, scheduler computes and stores the next occurrence.
- Task remains `active` unless paused/cancelled.

## How execution works

1. `startSchedulerLoop` wakes every `SCHEDULER_POLL_INTERVAL` (60s).
2. It queries due tasks (`getDueTasks`) where `status='active'` and `next_run <= now`.
3. Each task is re-checked (`getTaskById`) to avoid races (e.g., paused between poll and execution).
4. Task is queued in `GroupQueue` (same queue framework as message-driven runs).
5. `runTask(...)` invokes `runContainerAgent(...)` with `isScheduledTask: true`.
6. Results are handled and task metadata is updated:
   - run log row inserted (`logTaskRun`)
   - `next_run` and `last_result` updated (`updateTaskAfterRun`)

## Output delivery paths during task execution

A task can message users in two ways:

1. Direct streamed output path
- Agent returns text result in stream.
- Scheduler callback forwards it via `sendMessage` -> WhatsApp.

2. MCP IPC path
- Agent explicitly calls MCP `send_message`.
- Tool writes IPC message file.
- `IPC Watcher` forwards message to WhatsApp.

Both paths can be used in the same run.

## Task control operations

Via IPC/MCP tools:
- `pause_task` -> sets `status='paused'`
- `resume_task` -> sets `status='active'`
- `cancel_task` -> deletes task row and run logs

Main-group context can operate across groups. Non-main groups are scoped to their own group.

## Context mode (`group` vs `isolated`)

- `group`: task execution reuses the group session ID (conversation continuity).
- `isolated`: task executes without resuming group session.

This is controlled per task by `context_mode`.

## Quick inspection queries

List tasks:

```sql
SELECT id, group_folder, schedule_type, schedule_value, status, next_run, last_run
FROM scheduled_tasks
ORDER BY created_at DESC;
```

Recent task runs:

```sql
SELECT task_id, run_at, status, substr(result,1,120), substr(error,1,120)
FROM task_run_logs
ORDER BY run_at DESC
LIMIT 20;
```
