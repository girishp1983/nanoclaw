# Replacing Claude SDK with Kiro CLI in NanoClaw

This is the NanoClaw-focused adaptation summary.

## Why

- Standardize execution backend on Kiro CLI custom agent
- Reuse existing WhatsApp + scheduler + SQLite architecture
- Keep MCP tooling for messaging and task scheduling

## What Changed in NanoClaw

## Host layer (unchanged responsibilities)
- `src/index.ts`: routing, queueing, WhatsApp orchestration
- `src/task-scheduler.ts`: due-task execution and logging
- `src/ipc.ts`: MCP command consumption and authorization
- `src/db.ts`: persistence

## Runner layer (changed)
- `container/agent-runner/src/index.ts`:
  - removed Claude SDK `query(...)` path
  - added `kiro-cli chat` process launch
  - kept marker-based output protocol expected by host
  - kept IPC input draining and `_close` sentinel handling

## Config bridge (new behavior)
- Runtime patching of `~/.kiro/agents/agent_config.json` to ensure:
  - `mcpServers.nanoclaw`
  - `@nanoclaw` in `tools`
  - `@nanoclaw` in `allowedTools`

## Command Contract

NanoClaw now executes:

```bash
kiro-cli chat --no-interactive --trust-all-tools --wrap never --agent <resolved-agent> [--resume] "<prompt>"
```

## Session/Memory Continuity

- SQL `sessions` table stores per-group markers
- runner emits synthetic IDs (`kiro:<groupFolder>`) for host continuity
- group cwd (`groups/<group>/`) keeps workspace-local context
- Kiro custom agent prompt and tool config come from `~/.kiro/agents/agent_config.json`

## Known Gaps

- No SDK-native structured streaming events; output is normalized from CLI stdout/stderr
- Queue serialization per group means one long run can delay subsequent due tasks
