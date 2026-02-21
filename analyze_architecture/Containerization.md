# Containerization (Docker Desktop)

## 1) What Runs Where

Current runtime model is **hybrid**:
- Host process (`com.nanoclaw` via `launchd`) handles WhatsApp connection, scheduler, IPC watcher.
- Agent execution is containerized: host spawns `nanoclaw-agent:latest` containers on demand.

So it is expected to see:
- `launchctl list | grep nanoclaw` -> running host orchestrator
- `docker ps` -> empty when idle, active `nanoclaw-main-...` container only during agent work

## 2) How the Container Is Built

Primary path:
```bash
./.kiro/skills/setup/scripts/03-setup-container.sh
```

Equivalent direct build:
```bash
docker build -t nanoclaw-agent:latest ./container
```

Key build details:
- Image installs `kiro-cli` in container.
- Entry point is `/app/entrypoint.sh` (reads JSON from stdin, runs agent-runner).
- Agent runner code is in `container/agent-runner`.

## 3) Runtime Mounts (Host -> Container)

Configured in `src/container-runner.ts`:
- `groups/<group>` -> `/workspace/group`
- `groups/global` -> `/workspace/global`
- `groups/extra` -> `/workspace/extra`
- `ipc/<group>` -> `/workspace/ipc`
- `~/.kiro` -> `/home/node/.kiro`
- `~/.aws` -> `/home/node/.aws`
- `~/Library/Application Support/kiro-cli` -> `/home/node/.local/share/kiro-cli`

Last two mounts were critical for Kiro auth persistence in containerized runs.

## 4) How to Verify Process + Container

Check service:
```bash
launchctl list | grep nanoclaw
```

Check containers:
```bash
docker ps
```

Check app logs:
```bash
tail -f logs/nanoclaw.log
```

Healthy signs in logs:
- `Connected to WhatsApp`
- `Scheduler loop started`
- `Spawning agent process` with `runtime: "docker"`
- `Message sent`

## 5) WhatsApp Authentication (What We Had To Do)

When logged out / 401:
1. Re-auth:
```bash
npm run auth
```
2. If stale session, move old auth and retry:
```bash
mv store/auth store/auth.bak.$(date +%s)
npm run auth
```
3. Pairing-code mode (optional):
```bash
npm run auth -- --pairing-code --phone <your_number_with_country_code>
```

After success, credentials persist under `store/auth`, so restart normally keeps auth.

## 6) Kiro Authentication (What We Had To Do)

Symptoms:
- Container runs failed with:
  - `Failed to open browser for authentication`

Actions taken:
1. Verified host login:
```bash
kiro-cli whoami
```
2. Identified container was missing auth state visibility.
3. Added persistent mounts in `src/container-runner.ts`:
   - `~/.aws`
   - `~/Library/Application Support/kiro-cli`
4. Rebuild + restart:
```bash
npm run build
./.kiro/skills/setup/scripts/03-setup-container.sh
./.kiro/skills/setup/scripts/08-setup-service.sh
```
5. Verified container sees login:
```bash
docker run --rm \
  -v "$HOME/.kiro:/home/node/.kiro" \
  -v "$HOME/.aws:/home/node/.aws" \
  -v "$HOME/Library/Application Support/kiro-cli:/home/node/.local/share/kiro-cli" \
  --entrypoint /usr/local/bin/kiro-cli \
  nanoclaw-agent:latest whoami
```

## 7) What Was Done So You Don’t Have To Repeat It

Persistent fixes already in code:
- Added `~/.aws` mount to container runtime.
- Added `~/Library/Application Support/kiro-cli` mount to container runtime.

Operationally persistent:
- WhatsApp auth persists in `store/auth`.
- Kiro auth persists in host auth locations now mounted into runtime containers.
- Service restarts use same launchd plist (`com.nanoclaw`).

As long as those host auth directories are not deleted, re-auth should not be needed on each restart.
