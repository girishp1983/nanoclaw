# Deployment Notes

## Purpose
This file explains how source code is compiled, what appears in `dist/`, and how NanoClaw is built and deployed.

## `src/` vs `dist/`

- `src/` contains handwritten TypeScript source files.
- `dist/` contains generated build artifacts produced by `tsc`.
- Runtime entrypoint is `dist/index.js` (`package.json` -> `main`).

Why `dist/` has many more files than `src/`:
- TypeScript is configured to emit multiple artifact types per source file.
- In this repo, `tsconfig.json` enables:
  - `declaration: true`
  - `declarationMap: true`
  - `sourceMap: true`
- So each `.ts` can emit up to 4 files.

## Meaning of the 4 file types

- `.js`
  - Compiled JavaScript executed by Node.js.
- `.js.map`
  - Source map from compiled `.js` back to original `.ts` for debugging.
- `.d.ts`
  - Type declaration file for TypeScript type checking/intellisense.
- `.d.ts.map`
  - Declaration map linking `.d.ts` back to original `.ts` for editor navigation.

## Build Commands

From project root:

```bash
npm run build
```

What it does (`package.json`):
1. Runs host TypeScript build: `tsc` (`src/` -> `dist/`).
2. Builds agent runner in `container/agent-runner` (`npm install` + `npm run build`).

Useful alternatives:

```bash
npm run build:agent   # Build only container/agent-runner
npm run dev           # Build agent runner, then run host from src with tsx
npm run start         # Run compiled host: node dist/index.js
npm run typecheck     # Type check only (no output files)
```

## Deploy (macOS launchd)

NanoClaw is intended to run as a launch agent (`com.nanoclaw`).

Typical commands:

```bash
# Install/load
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop/unload
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && \
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Status
launchctl list | grep nanoclaw
```

Logs:

- `logs/nanoclaw.log`
- `logs/nanoclaw.error.log`

## Recommended update flow

1. Pull/code changes.
2. Rebuild:

```bash
npm run build
```

3. Restart launchd service:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && \
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

4. Verify:

```bash
launchctl list | grep nanoclaw
tail -n 100 logs/nanoclaw.log
```
