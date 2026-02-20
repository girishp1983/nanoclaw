# Plan: Run NanoClaw Without Containers

## Context

Apple Container's builder VM has broken DNS (can't resolve any hostnames), preventing the container image from building. Docker Desktop requires org sign-in. Rather than debugging infrastructure, we bypass containers entirely and run the agent-runner as a direct Node.js child process on the host. The same stdin/stdout JSON protocol is preserved — all callers remain unchanged.

## Changes

### 1. Agent-runner: replace hardcoded `/workspace/*` paths with env vars

**`container/agent-runner/src/index.ts`** — 5 path references:

Add path constants at top (after imports):
```typescript
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const EXTRA_DIR = process.env.NANOCLAW_EXTRA_DIR || '/workspace/extra';
```

Then replace:
- Line 57: `'/workspace/ipc/input'` → `path.join(IPC_BASE_DIR, 'input')`
- Line 168: `'/workspace/group/conversations'` → `path.join(GROUP_DIR, 'conversations')`
- Line 394: `'/workspace/global/CLAUDE.md'` → `path.join(GLOBAL_DIR, 'CLAUDE.md')`
- Line 403: `'/workspace/extra'` → `EXTRA_DIR`
- Line 419: `cwd: '/workspace/group'` → `cwd: GROUP_DIR`

**`container/agent-runner/src/ipc-mcp-stdio.ts`** — 1 path reference:

- Line 14: `'/workspace/ipc'` → `process.env.NANOCLAW_IPC_DIR || '/workspace/ipc'`

### 2. Container-runner: spawn `node` instead of `container`

**`src/container-runner.ts`**:

- Remove `import { exec }` (only `spawn` and `ChildProcess` needed)
- Remove `CONTAINER_IMAGE` from config imports
- Remove `VolumeMount` interface
- Replace `buildVolumeMounts()` with `buildProcessEnv()` that returns `Record<string, string>` with:
  - `NANOCLAW_GROUP_DIR` → `groups/{folder}/`
  - `NANOCLAW_IPC_DIR` → `data/ipc/{folder}/`
  - `NANOCLAW_GLOBAL_DIR` → `groups/global/`
  - `NANOCLAW_EXTRA_DIR` → `data/extra/{folder}/` (symlinks to validated mounts)
  - `HOME` → `data/sessions/{folder}/` (so `~/.claude/` resolves to per-group sessions)
  - `PATH` → inherited from `process.env.PATH`
  - `NANOCLAW_PROJECT_DIR` → project root (main only, for reference)
  - Keep same side effects: create IPC dirs, session dirs, sync skills, write settings.json
- Remove `buildContainerArgs()` entirely
- In `runContainerAgent()`: spawn `node container/agent-runner/dist/index.js` with `cwd` set to group dir and `env` from `buildProcessEnv()`
- Replace timeout kill: `exec('container stop ...')` → `container.kill('SIGTERM')` then `SIGKILL` after 15s grace
- Update log messages from "container" to "agent process"

### 3. Index: remove container system startup

**`src/index.ts`**:

- Remove `import { execSync } from 'child_process'`
- Remove `ensureContainerSystemRunning()` function (lines 388-448)
- Remove call `ensureContainerSystemRunning()` in `main()` (line 451)

### 4. Config: remove container image constant

**`src/config.ts`**:

- Remove `CONTAINER_IMAGE` export

### 5. Build chain: compile agent-runner on host

**`package.json`**:

```json
"build": "tsc && cd container/agent-runner && npm install && npm run build",
"build:agent": "cd container/agent-runner && npm install && npm run build",
"dev": "npm run build:agent && tsx src/index.ts"
```

### 6. Revert Dockerfile DNS hack

**`container/Dockerfile`**: Remove the DNS fix lines added during this session, restoring original state.

## Files Modified

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | 5 path refs → env vars |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 1 path ref → env var |
| `src/container-runner.ts` | Spawn node directly instead of container |
| `src/index.ts` | Remove container system startup |
| `src/config.ts` | Remove `CONTAINER_IMAGE` |
| `package.json` | Add agent-runner build to build chain |
| `container/Dockerfile` | Revert DNS hack |

## What stays the same

- Agent-runner logic (query loop, IPC, hooks, MCP server)
- IPC system (`src/ipc.ts`)
- Group queue (`src/group-queue.ts`)
- Task scheduler
- Mount security validation
- All callers of `runContainerAgent()` — same interface
- Stdin/stdout JSON protocol with output markers

## Verification

1. `npm run build` — should compile both host code and agent-runner
2. `npm run dev` — should start without container system errors
3. Send a WhatsApp message — agent should respond (after auth + registration in later setup steps)
