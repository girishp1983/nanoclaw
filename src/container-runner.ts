/**
 * Agent Process Runner for NanoClaw
 * Spawns agent execution as a direct Node.js child process and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_IMAGE,
  AGENT_ONE_SHOT,
  AGENT_RUNTIME,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ProcessContext {
  env: Record<string, string>;
  validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
}

function ensureMainKiroSteeringFile(projectRoot: string): void {
  const templatePath = path.join(projectRoot, 'Agents_template.md');
  const targetPath = path.join(
    GROUPS_DIR,
    MAIN_GROUP_FOLDER,
    '.kiro',
    'steering',
    'Agents.md',
  );

  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(templatePath)) {
    logger.warn({ templatePath }, 'Agents template missing, skipping main steering bootstrap');
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(templatePath, targetPath);
  logger.info({ targetPath }, 'Created main Kiro steering file from template');
}

function ensureGlobalKiroSteeringFile(projectRoot: string): void {
  const templatePath = path.join(projectRoot, 'Agents_global.md');
  const targetPath = path.join(
    GROUPS_DIR,
    'global',
    '.kiro',
    'steering',
    'Agents.md',
  );

  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(templatePath)) {
    logger.warn({ templatePath }, 'Global agents template missing, skipping global steering bootstrap');
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(templatePath, targetPath);
  logger.info({ targetPath }, 'Created global Kiro steering file from template');
}

/**
 * Build environment variables and prepare directories for the agent process.
 * Replaces the old buildVolumeMounts() — instead of container mounts,
 * the agent-runner reads these env vars to find the right host paths.
 */
function buildProcessEnv(
  group: RegisteredGroup,
  isMain: boolean,
): ProcessContext {
  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  ensureMainKiroSteeringFile(projectRoot);
  ensureGlobalKiroSteeringFile(projectRoot);

  // Per-group IPC namespace
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Per-group Claude sessions directory (isolated from other groups)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  const realHome = os.homedir();
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync MCP server config from user's real ~/.claude.json
  // Agent processes get a different HOME, so they can't see the user's MCP servers
  const sessionHome = path.dirname(groupSessionsDir);
  try {
    const userClaudeJson = path.join(realHome, '.claude.json');
    if (fs.existsSync(userClaudeJson)) {
      const userConfig = JSON.parse(fs.readFileSync(userClaudeJson, 'utf-8'));
      if (userConfig.mcpServers && Object.keys(userConfig.mcpServers).length > 0) {
        const sessionClaudeJson = path.join(sessionHome, '.claude.json');
        let sessionConfig: Record<string, unknown> = {};
        if (fs.existsSync(sessionClaudeJson)) {
          try {
            sessionConfig = JSON.parse(fs.readFileSync(sessionClaudeJson, 'utf-8'));
          } catch { /* start fresh */ }
        }
        sessionConfig.mcpServers = userConfig.mcpServers;
        fs.writeFileSync(sessionClaudeJson, JSON.stringify(sessionConfig, null, 2) + '\n');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to sync MCP server config');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }

  // Handle additional mounts via symlinks in a per-group extra directory
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  fs.mkdirSync(extraDir, { recursive: true });
  // Clean stale symlinks
  for (const entry of fs.readdirSync(extraDir)) {
    const linkPath = path.join(extraDir, entry);
    try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
  }
  let validatedMounts: ProcessContext['validatedMounts'] = [];
  if (group.containerConfig?.additionalMounts) {
    validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      // mount.containerPath is like '/workspace/extra/mydir'
      const name = path.basename(mount.containerPath);
      const linkPath = path.join(extraDir, name);
      try {
        fs.symlinkSync(mount.hostPath, linkPath);
      } catch (err) {
        logger.warn({ err, hostPath: mount.hostPath, linkPath }, 'Failed to create extra mount symlink');
      }
    }
  }

  const env: Record<string, string> = {
    // Agent-runner path resolution
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_GLOBAL_DIR: path.join(GROUPS_DIR, 'global'),
    NANOCLAW_EXTRA_DIR: extraDir,
    // Preserve user's real HOME for Kiro config/auth lookup
    NANOCLAW_REAL_HOME: realHome,
    // HOME set to parent of .claude/ so ~/.claude/ resolves to per-group sessions
    HOME: path.dirname(groupSessionsDir),
    // Propagate PATH so node/npx/claude are found
    PATH: process.env.PATH || '',
    // One-shot mode: run a single Kiro turn per container then exit.
    NANOCLAW_AGENT_ONE_SHOT: AGENT_ONE_SHOT ? '1' : '0',
  };

  if (isMain) {
    env.NANOCLAW_PROJECT_DIR = projectRoot;
  }

  return { env, validatedMounts };
}

/**
 * Read allowed secrets from .env for passing to the agent via stdin.
 * Secrets are never written to disk or passed as env vars.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const { env: processEnv, validatedMounts } = buildProcessEnv(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;
  const runtime = AGENT_RUNTIME === 'host' ? 'host' : 'docker';

  const agentRunnerEntry = path.join(
    process.cwd(), 'container', 'agent-runner', 'dist', 'index.js',
  );

  logger.debug(
    {
      group: group.name,
      processName,
      runtime,
      env: {
        NANOCLAW_GROUP_DIR: processEnv.NANOCLAW_GROUP_DIR,
        NANOCLAW_IPC_DIR: processEnv.NANOCLAW_IPC_DIR,
        HOME: processEnv.HOME,
      },
    },
    'Agent process configuration',
  );

  logger.info(
    {
      group: group.name,
      processName,
      runtime,
      isMain: input.isMain,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    let container: ChildProcess;
    if (runtime === 'docker') {
      const dockerArgs: string[] = [
        'run',
        '-i',
        '--rm',
        '--name',
        processName.slice(0, 63),
        '-v',
        `${processEnv.NANOCLAW_GROUP_DIR}:/workspace/group`,
        '-v',
        `${processEnv.NANOCLAW_GLOBAL_DIR}:/workspace/global`,
        '-v',
        `${processEnv.NANOCLAW_EXTRA_DIR}:/workspace/extra`,
        '-v',
        `${processEnv.NANOCLAW_IPC_DIR}:/workspace/ipc`,
      ];

      const hostKiroDir = path.join(processEnv.NANOCLAW_REAL_HOME, '.kiro');
      if (fs.existsSync(hostKiroDir)) {
        dockerArgs.push('-v', `${hostKiroDir}:/home/node/.kiro`);
      } else {
        logger.warn({ hostKiroDir }, 'Host ~/.kiro not found; containerized Kiro may fail to authenticate');
      }

      const hostAwsDir = path.join(processEnv.NANOCLAW_REAL_HOME, '.aws');
      if (fs.existsSync(hostAwsDir)) {
        dockerArgs.push('-v', `${hostAwsDir}:/home/node/.aws`);
      } else {
        logger.warn({ hostAwsDir }, 'Host ~/.aws not found; containerized Kiro device-flow tokens may be unavailable');
      }

      const hostKiroCliDataDir = path.join(
        processEnv.NANOCLAW_REAL_HOME,
        'Library',
        'Application Support',
        'kiro-cli',
      );
      if (fs.existsSync(hostKiroCliDataDir)) {
        dockerArgs.push('-v', `${hostKiroCliDataDir}:/home/node/.local/share/kiro-cli`);
      } else {
        logger.warn(
          { hostKiroCliDataDir },
          'Host Kiro CLI data directory not found; containerized kiro-cli may not see login state',
        );
      }

      for (const mount of validatedMounts) {
        dockerArgs.push(
          '-v',
          `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`,
        );
      }

      const dockerEnv: Record<string, string> = {
        NANOCLAW_GROUP_DIR: '/workspace/group',
        NANOCLAW_IPC_DIR: '/workspace/ipc',
        NANOCLAW_GLOBAL_DIR: '/workspace/global',
        NANOCLAW_EXTRA_DIR: '/workspace/extra',
        NANOCLAW_REAL_HOME: '/home/node',
        HOME: '/home/node',
        PATH: '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin',
        NANOCLAW_IN_DOCKER: '1',
        NANOCLAW_AGENT_ONE_SHOT: AGENT_ONE_SHOT ? '1' : '0',
      };
      if (process.env.KIRO_AGENT_NAME) {
        dockerEnv.KIRO_AGENT_NAME = process.env.KIRO_AGENT_NAME;
      }
      if (process.env.KIRO_MODEL) {
        dockerEnv.KIRO_MODEL = process.env.KIRO_MODEL;
      }

      for (const [key, value] of Object.entries(dockerEnv)) {
        dockerArgs.push('-e', `${key}=${value}`);
      }

      dockerArgs.push(AGENT_IMAGE);
      container = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: process.env.PATH || '',
        },
      });
    } else {
      container = spawn('node', [agentRunnerEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: groupDir,
        env: processEnv,
      });
    }

    onProcess(container, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk)
    input.secrets = readSecrets();
    container.stdin!.write(JSON.stringify(input));
    container.stdin!.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let processClosed = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);
    const containerName = processName.slice(0, 63);

    const forceRemoveDockerContainer = () => {
      if (runtime !== 'docker') return;
      const rm = spawn('docker', ['rm', '-f', containerName], {
        stdio: 'ignore',
        env: {
          ...process.env,
          PATH: process.env.PATH || '',
        },
      });
      rm.on('error', (err) => {
        logger.debug(
          { group: group.name, containerName, error: err },
          'Best-effort docker rm -f failed',
        );
      });
      rm.unref();
    };

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Agent process timeout, sending SIGTERM');
      try {
        container.kill('SIGTERM');
      } catch (err) {
        logger.warn({ group: group.name, processName, error: err }, 'Failed to send SIGTERM to agent process');
      }
      setTimeout(() => {
        if (!processClosed) {
          logger.warn({ group: group.name, processName }, 'SIGTERM ignored, sending SIGKILL');
          try {
            container.kill('SIGKILL');
          } catch (err) {
            logger.warn({ group: group.name, processName, error: err }, 'Failed to send SIGKILL to agent process');
          }
          forceRemoveDockerContainer();
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      processClosed = true;
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Agent Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Process: ${processName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, processName, duration, code },
          'Agent timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Env ===`,
          Object.entries(processEnv)
            .filter(([k]) => k.startsWith('NANOCLAW_') || k === 'HOME')
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Agent exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Agent completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse agent output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      processClosed = true;
      clearTimeout(timeout);
      logger.error({ group: group.name, processName, error: err }, 'Agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the agent to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
