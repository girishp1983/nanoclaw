# Deployment Notes (Kiro Runtime)

## Purpose

How to build, deploy, restart, and verify NanoClaw when runtime backend is Kiro CLI.

## `src/` vs `dist/`

- `src/`: TypeScript source files
- `dist/`: compiled JavaScript used by production service

Important:
- launchd runs `dist/index.js`
- `container/agent-runner` also compiles to `container/agent-runner/dist/index.js`

## Build

```bash
npm run build
```

This compiles:
- host app (`src` -> `dist`)
- agent-runner (`container/agent-runner/src` -> `container/agent-runner/dist`)

## Restart Service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Verify After Restart

```bash
launchctl list | rg com.nanoclaw

# runtime logs
tail -n 100 logs/nanoclaw.log
tail -n 100 logs/nanoclaw.error.log
```

Expected signals:
- DB initialized
- WhatsApp connected
- Scheduler started
- IPC watcher started

## Smoke Test

1. Send a WhatsApp message to a registered group.
2. Watch logs for:
- message persisted
- queue processing
- agent process spawn
- outbound message

Optional task smoke test:
- create a one-time task due within 1-2 minutes
- confirm `scheduled_tasks` row and `task_run_logs` entry

## Release Hygiene

Before pushing:
```bash
npm run typecheck
npm run test
```

Then:
```bash
git add -A
git commit -m "..."
git push origin <branch>
```
