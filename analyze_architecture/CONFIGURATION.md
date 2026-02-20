# NanoClaw Configuration

Where all configuration, credentials, and state are stored.

## The `/setup` Skill

The `/setup` skill (`.claude/skills/setup/SKILL.md`) is the interactive first-time installer. It runs inside Claude Code and walks through 11 scripted steps, pausing only when user action is required. Scripts live in `.claude/skills/setup/scripts/` and log to `logs/setup.log`.

### What it does (step by step)

| Step | Script | What it does | User action required |
|------|--------|-------------|---------------------|
| 1. Check Environment | `01-check-environment.sh` | Detects OS, Node.js version, container runtime, existing `.env`, WhatsApp auth, registered groups | None |
| 2. Install Dependencies | `02-install-deps.sh` | Runs `npm install` for the host project | None (auto-fixes common errors like permission issues) |
| 3. Container Runtime | `03-setup-container.sh` | Sets up Apple Container or Docker; builds the agent image. Skipped in containerless mode. | May ask to choose runtime or install one |
| 4. Claude Authentication | (no script) | Guides user to run `claude setup-token` in another terminal and add the token to `.env` | Yes — paste token into `.env` file |
| 5. WhatsApp Authentication | `04-auth-whatsapp.sh` | Generates QR code (browser, terminal, or pairing code) for WhatsApp linking | Yes — scan QR code with phone |
| 6. Configure Trigger & Channel | (no script) | Asks: does bot share your number? What trigger word? Main channel type (self-chat, solo group, DM)? | Yes — answer questions |
| 7. Sync & Select Group | `05-sync-groups.sh`, `05b-list-groups.sh` | Syncs WhatsApp group metadata to SQLite, lists groups for selection | Yes — pick or create a group |
| 8. Register Channel | `06-register-channel.sh` | Writes group registration to SQLite, creates group folder, updates CLAUDE.md with assistant name | None |
| 9. Mount Allowlist | `07-configure-mounts.sh` | Asks if agent should access external directories, writes `~/.config/nanoclaw/mount-allowlist.json` | Yes — choose directories |
| 10. Start Service | `08-setup-service.sh` | Fills `{{placeholders}}` in plist template, copies to `~/Library/LaunchAgents/`, loads via `launchctl` | None |
| 11. Verify | `09-verify.sh` | Checks service running, credentials configured, WhatsApp auth, registered groups, mount allowlist | None |

### What it creates/modifies

| File/Directory | Created by step |
|----------------|----------------|
| `node_modules/` | Step 2 |
| `.env` | Step 4 (user adds token) |
| `store/auth/` | Step 5 (WhatsApp credentials) |
| `store/messages.db` | Step 7 (group sync populates chats + registered_groups tables) |
| `groups/main/` | Step 8 |
| `groups/main/CLAUDE.md` | Step 8 (assistant name updated if not "Andy") |
| `groups/global/CLAUDE.md` | Step 8 (assistant name updated if not "Andy") |
| `~/.config/nanoclaw/mount-allowlist.json` | Step 9 |
| `~/Library/LaunchAgents/com.nanoclaw.plist` | Step 10 |
| `logs/setup.log` | All steps (verbose logs) |

### Re-running `/setup`

Safe to re-run — each step checks existing state first and offers to skip or reconfigure. Useful for:
- Re-authenticating WhatsApp (step 5)
- Changing trigger word or channel type (steps 6-8)
- Fixing a broken service (step 10-11)

For post-setup changes (adding channels, integrations), use `/customize` instead.

## Claude Token

| Item | Location |
|------|----------|
| Token file | `.env` (project root) |
| Supported variables | `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY` (pay-per-use) |
| Read by | `src/env.ts` → `readEnvFile()` |
| Used in | `src/container-runner.ts` → `readSecrets()` |
| Passed to agent via | **stdin** (JSON payload) — never written to disk or environment variables |

The `.env` file is parsed on every agent spawn. After the token is written to stdin, it's deleted from the input object so it never appears in logs.

Example `.env`:
```
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
# or
ANTHROPIC_API_KEY=sk-ant-...
```

## WhatsApp Credentials

| Item | Location |
|------|----------|
| Auth store | `store/auth/` (924 files — session keys, identity, prekeys) |
| Created by | `npm run auth` or `/setup` (QR code scan) |
| Used by | Baileys library in `src/channels/whatsapp.ts` |
| Persists across restarts | Yes — QR scan only needed once |
| Expiry | WhatsApp may invalidate after ~14 days of inactivity or manual unlink from phone |

To re-authenticate: `npm run auth`

## Registered Groups

| Item | Location |
|------|----------|
| Storage | `store/messages.db` → `registered_groups` table |
| Columns | `jid`, `name`, `folder`, `trigger_pattern`, `requires_trigger`, `container_config` |
| Configured by | `/setup` (first time) or `/customize` (add more) |
| Query | `sqlite3 store/messages.db "SELECT jid, name, folder, trigger_pattern FROM registered_groups;"` |

## Per-Group Session Isolation

Each registered group gets its own Claude session directory:

```
data/sessions/<group>/
├── .claude.json          # MCP server config (synced from ~/.claude.json on every agent spawn)
└── .claude/
    ├── settings.json     # Claude Code env vars (agent teams, memory, etc.)
    └── skills/           # Synced from container/skills/
```

The `HOME` env var is set to `data/sessions/<group>/` so `~/.claude/` resolves to the per-group directory. This is what provides session isolation between groups.

## Group Scope: `main` vs `global`

Yes, `main` is one specific group.

- The special main group folder name is fixed as `main` (`MAIN_GROUP_FOLDER`): `src/config.ts:31`
- A registered group whose `folder` is `main` is treated as the main/control group in runtime checks (`isMain`), e.g. `src/index.ts:123`, `src/index.ts:213`, `src/container-runner.ts:159`

`CLAUDE.md` scope differs:

- `groups/main/CLAUDE.md`:
  - Applies to the main/control group's own runs (because agent `cwd` is that group folder)
  - Code: `container/agent-runner/src/index.ts:426`
- `groups/global/CLAUDE.md`:
  - Shared baseline context appended for non-main groups only
  - Code: `container/agent-runner/src/index.ts:401`, `container/agent-runner/src/index.ts:403`, `container/agent-runner/src/index.ts:430`

Practical behavior:

- Main group run: uses `groups/main/CLAUDE.md` (its own group context)
- Non-main group run: uses `groups/<group>/CLAUDE.md` plus appended `groups/global/CLAUDE.md`

## Transcript Storage vs Archived Conversations

These are different locations:

- Raw Claude session artifacts/transcripts:
  - `data/sessions/<group>/.claude/projects/.../*.jsonl`
  - Main group example: `data/sessions/main/.claude/projects/-Users-girpatil-Documents-Coding-ClaudeCode-cowork-nanoclaw-groups-main/*.jsonl`
- Archived conversation markdown (pre-compact hook output):
  - `groups/<group>/conversations/*.md`
  - Main group location: `groups/main/conversations/`

Important behavior:

- `groups/main/conversations/` is created only when the pre-compact hook runs and writes an archive.
- So it may not exist yet even when `data/sessions/main/.claude/projects/...` already contains session transcript files.
- Archive creation code: `container/agent-runner/src/index.ts:175`, `container/agent-runner/src/index.ts:183`

## MCP Servers

| Item | Location |
|------|----------|
| User's global config | `~/.claude.json` → `mcpServers` key |
| Per-group copy | `data/sessions/<group>/.claude.json` |
| Synced by | `buildProcessEnv()` in `src/container-runner.ts` |
| Sync timing | Every agent spawn (no restart needed for changes) |

### Exact Paths (This Workspace)

For your current machine/workspace, the files involved in MCP sync are:

- Source file read by host: `/Users/girpatil/.claude.json`
- Per-group target file written by NanoClaw: `/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/data/sessions/<group>/.claude.json`
- Current main group target: `/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/data/sessions/main/.claude.json`
- Per-group Claude settings file: `/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/data/sessions/<group>/.claude/settings.json`
- Current main group settings file: `/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/data/sessions/main/.claude/settings.json`

Code locations for this behavior:

- Sync implementation: `src/container-runner.ts:80`
- Source path resolution (`os.homedir()` + `.claude.json`): `src/container-runner.ts:84`
- Destination path construction (`sessionHome/.claude.json`): `src/container-runner.ts:89`
- Write of synced `mcpServers`: `src/container-runner.ts:97`
- Per-group HOME mapping used by agent process: `src/container-runner.ts:154`

## Session Continuity (FAQ)

### Does every conversation create a new Claude session?

No. NanoClaw reuses one Claude session per group when available.

- Session ID lookup before run: `src/index.ts:214`
- Session resume passed to SDK: `container/agent-runner/src/index.ts:428`
- New session ID persisted when emitted by SDK: `src/index.ts:245`, `src/index.ts:267`
- Persistent storage table: `sessions` in `store/messages.db` (`src/db.ts:63`)

New session is created only when:

- No prior `sessionId` exists for that group
- A scheduled task is run with `context_mode='isolated'` (session intentionally not resumed), see `src/task-scheduler.ts:90`

## Assistant Identity

| Item | Location | Default |
|------|----------|---------|
| Name | `.env` → `ASSISTANT_NAME` or launchd plist `EnvironmentVariables` | `Andy` |
| Has own number | `.env` → `ASSISTANT_HAS_OWN_NUMBER` | `false` |
| Trigger pattern | SQLite `registered_groups.trigger_pattern` | `@<ASSISTANT_NAME>` |
| Per-group CLAUDE.md | `groups/<folder>/CLAUDE.md` | Set during `/setup` |
| Global CLAUDE.md | `groups/global/CLAUDE.md` | Shared across all groups |

## Mount Allowlist

| Item | Location |
|------|----------|
| Config file | `~/.config/nanoclaw/mount-allowlist.json` |
| Purpose | Controls which host directories the agent can access beyond its group folder |
| Used by | `src/mount-security.ts` → `validateAdditionalMounts()` |
| Exposed as | Symlinks in `data/extra/<group>/` |

## IPC Directories

Each group gets its own IPC namespace:

```
data/ipc/<group>/
├── messages/    # Outbound WhatsApp messages written by agent
├── tasks/       # Task schedule/pause/resume/cancel commands
└── input/       # Follow-up messages from host to running agent
```

## Launchd Service

| Item | Location |
|------|----------|
| Template | `launchd/com.nanoclaw.plist` (has `{{placeholders}}`) |
| Installed copy | `~/Library/LaunchAgents/com.nanoclaw.plist` |
| Stdout log | `logs/nanoclaw.log` |
| Stderr log | `logs/nanoclaw.error.log` |
| Per-group agent logs | `groups/<group>/logs/` |

## SQLite Database

| Item | Location |
|------|----------|
| Database file | `store/messages.db` |
| Schema/migrations | `src/db.ts` |

Key tables:
- `registered_groups` — group registrations and trigger config
- `messages` — WhatsApp message history
- `chats` — chat metadata
- `sessions` — per-group Claude session IDs
- `scheduled_tasks` — cron/interval/once tasks
- `task_runs` — task execution logs
- `router_state` — message cursor positions

## Directory Layout Summary

```
nanoclaw/
├── .env                          # Secrets (Claude token)
├── store/
│   ├── auth/                     # WhatsApp credentials
│   └── messages.db               # SQLite database
├── data/
│   ├── sessions/<group>/         # Per-group Claude HOME
│   │   ├── .claude.json          # MCP servers (synced)
│   │   └── .claude/settings.json # Claude Code settings
│   ├── ipc/<group>/              # Per-group IPC dirs
│   └── extra/<group>/            # Symlinks to allowed mounts
├── groups/
│   ├── global/CLAUDE.md          # Shared memory
│   └── <group>/
│       ├── CLAUDE.md             # Per-group memory
│       └── logs/                 # Agent run logs
├── logs/                         # Service logs
└── ~/Library/LaunchAgents/
    └── com.nanoclaw.plist        # Launchd service config
```
