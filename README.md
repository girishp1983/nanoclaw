# Kiro-Claw

Personal WhatsApp assistant powered by **Kiro CLI** and a **custom Kiro agent**. It has 500+ tools like audio, video generation; email, calendar etc.

Kiro-Claw runs as a small Node.js service:
- Reads inbound WhatsApp messages
- Persists state in SQLite
- Launches `kiro-cli chat` for reasoning/execution
- Delivers responses back to WhatsApp

# Features of Kiro-Claw
- Can run 24 by 7
- 500+ plus tools
- Access via WhatApp
- Supports one-time and recurring scheduled tasks, just ask it to do something at certain time
- It has Agent.md file that it uses to remember your details and preference. It intimately knows you over a period of time. You can defini its soul there.
- For other memories it can create .md files, it can build Skill.md to develop skills
- Leverages Custom Agent feature of Kiro-CLI. It loads MCPs, Skills and Agents.md as per agent_config.json
- Setup is very easy. Just lauch Kiro-CLI in route folder and ask it to help you with setup. That is it!!!

## Guided Setup With Kiro `setup` Skill

Start `kiro-cli` at the project root and ask:

`Use the setup skill to configure Kiro-Claw for WhatsApp and register my main group.`

The setup skill automates full bootstrap (not just WhatsApp auth):
1. Checks environment prerequisites and existing state (Node, `kiro-cli`, Kiro agent config, existing WhatsApp auth, existing registered groups).
2. Installs project dependencies.
3. Validates host runtime readiness (`npm run build`, `kiro-cli`, `~/.kiro/agents/agent_config.json`).
4. Handles WhatsApp authentication (QR browser, pairing code, or terminal QR), with retry flow.
5. Reads authenticated bot number from `store/auth/creds.json`.
6. Asks for trigger word and channel type (group vs DM/self-chat).
7. For group channels, syncs chats from WhatsApp and lists candidate groups by name.
8. Maps selected group name to JID (or uses DM JID), then registers the channel in `registered_groups` (`jid`, `folder`, trigger settings).
9. Supports later reconfiguration to move `main` to a different WhatsApp group.
10. Configures mount allowlist at `~/.config/nanoclaw/mount-allowlist.json`.
11. Builds and installs background service config (`launchd` on macOS, `systemd` on Linux), then loads/starts it.
12. Runs end-to-end verification (service status, Kiro CLI/config, WhatsApp auth, registered groups, mount config).
13. Provides log locations and troubleshooting guidance when checks fail.

Important detail: group name is used only for selection UX; runtime routing is done by registered JID.

## How Kiro-CLI is launched to perform tasks?

Kiro-Claw launches Kiro through `container/agent-runner`:
- Command shape:
  - `kiro-cli chat --no-interactive --trust-all-tools --wrap never --agent <agentName> <prompt>`
- Agent name is read from:
  - `~/.kiro/agents/agent_config.json` (`name`)
  - or `KIRO_AGENT_NAME` env override
  - default fallback: `kiro-assistant`
- Optional model override:
  - `KIRO_MODEL`

Kiro-Claw passes `--resume` when a saved group session marker exists; first turn starts new, subsequent turns resume.

At run time, Kiro-Claw ensures your Kiro agent config (`~/.kiro/agents/agent_config.json`) includes:
- `nanoclaw` MCP server entry
- `@nanoclaw` in `tools` and `allowedTools`
- steering resource `file://.kiro/steering/Agents.md`

Kiro tool/MCP availability and resource loading come from this same agent config file, including skill/resource paths (commonly `~/.kiro/skills`).

## Steering Bootstrap

Before agent execution, Kiro-Claw bootstraps steering files if missing:
- `Agents_template.md` -> `groups/main/.kiro/steering/Agents.md` (create only if target missing)
- `Agents_global.md` -> `groups/global/.kiro/steering/Agents.md` (create only if target missing)

This bootstrap is performed by NanoClaw host code in `src/container-runner.ts` during agent-run preparation.

If target files already exist, Kiro-Claw leaves them untouched.

## Core Features

- WhatsApp message handling (Baileys)
- Group-level isolation (`groups/<group>/`)
- SQLite persistence (`store/messages.db`)
- Per-group queueing and backpressure
- Scheduler (`once`, `cron`, `interval`)
- MCP-based tool bridge (`send_message`, `schedule_task`, task controls)

## Architecture (High Level)

```mermaid
flowchart LR
  WA[WhatsApp] --> CH[WhatsAppChannel]
  CH --> DB[(SQLite)]
  DB --> LOOP[Message Loop]
  LOOP --> Q[GroupQueue]
  Q --> RUN[Agent Runner]
  RUN --> KIRO[kiro-cli chat]
  RUN --> IPC[data/ipc]
  IPC --> WATCH[IPC Watcher]
  WATCH --> CH
  DB --> SCH[Scheduler]
  SCH --> Q
```

## Memory Model (Short)

Memory for Kiro comes from multiple layers:
- Prompt context from SQL (`messages` since last cursor)
- Group files in `groups/<group>/` (especially `.kiro/steering/*.md` and other memory `.md` files)
- Kiro custom-agent prompt/config from `~/.kiro/agents/agent_config.json`
- Task/run metadata in SQL (`scheduled_tasks`, `task_run_logs`)

For full details: `analyze_architecture/MEMORY.md`.

## Quick Start

Recommendation: for first-time setup, run the guided setup flow even if you plan to use `Quick Start` only. It configures WhatsApp auth, group/JID registration, and validation checks required by both run modes. If you only want foreground mode afterward, you can unload launchd service.

1. Install dependencies:
```bash
npm install
```

2. Authenticate WhatsApp:
```bash
npm run auth
```

3. Ensure Kiro CLI is installed and logged in:
```bash
kiro-cli whoami
```

4. Ensure your custom agent exists:
- `~/.kiro/agents/agent_config.json`
- Example agent name: `kiro-assistant`

5. Build and start:
```bash
npm run build
npm start
```

You can also ask Kiro to help with setup. Launch `kiro-cli` from the NanoClaw project root and ask it to set up Kiro-claw for you:
```bash
cd /path/to/nanoclaw
kiro-cli
```

## Run As Service (macOS launchd)

Quick Start vs Run As Service:
- `Quick Start` runs NanoClaw in the foreground (`npm start`) for local/manual use.
- `Run As Service` runs NanoClaw in background via launchd (`com.nanoclaw`) for 24x7 operation and auto-restart.
- For first-time setup in either mode, ensure at least one WhatsApp target is registered in `registered_groups` (setup skill handles this).

The setup skill runs:

```bash
./.kiro/skills/setup/scripts/08-setup-service.sh
```

What this script does on macOS:
- Runs `npm run build`
- Generates `~/Library/LaunchAgents/com.nanoclaw.plist`
- Sets launchd `ProgramArguments` to `node <project>/dist/index.js`
- Sets `WorkingDirectory`, `HOME`, stdout/stderr log paths
- Auto-computes service `PATH` (detected `kiro-cli` dir, detected `node` dir, `~/.local/bin`, `~/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`)
- Calls `launchctl load` and verifies service appears in `launchctl list`

```bash
# load service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# unload service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# restart after build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# view logs
tail -f logs/nanoclaw.log
tail -f logs/nanoclaw.error.log
```

## Docs

See `analyze_architecture/`:
- `Architecture.md`
- `CONFIGURATION.md`
- `MEMORY.md`
- `SCHEDULED_TASKS.md`
- `Launch_Kiro_nanoClaw.md`
- `Linting.md`

Troubleshooting:
- `docs/TROUBLESHOOTING.md`

## License

MIT
