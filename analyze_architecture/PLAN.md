# Kiro Runtime Plan

This file tracks the architecture direction where NanoClaw executes user requests through **Kiro CLI custom agent** instead of Claude SDK.

## Goals

- Use `kiro-cli chat` as the only execution backend
- Keep existing host architecture (WhatsApp, SQLite, scheduler, IPC)
- Preserve MCP task/message tooling through NanoClaw MCP bridge
- Keep group-level isolation semantics

## Implemented

- Replaced SDK query path in `container/agent-runner/src/index.ts`
- Added Kiro command launcher and output normalization
- Added Kiro custom agent resolution from `~/.kiro/agents/agent_config.json`
- Added runtime injection of `nanoclaw` MCP + `@nanoclaw` tool tags
- Added `NANOCLAW_REAL_HOME` pass-through from host runner

## Operational Risks

- Long-running task runs can delay other due tasks in same group queue
- `--resume` semantics are determined by Kiro CLI behavior
- MCP server load failures inside Kiro may degrade tool availability

## Verification Checklist

1. `kiro-cli whoami` succeeds
2. `npm run build` succeeds
3. Service restarts cleanly
4. Inbound WhatsApp message returns response
5. `schedule_task` creates DB row and executes
6. `send_message` tool path emits outbound WhatsApp messages
