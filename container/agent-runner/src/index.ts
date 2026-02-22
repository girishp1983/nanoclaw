/**
 * NanoClaw Agent Runner (Kiro CLI backend)
 * Receives config via stdin and executes prompts via kiro-cli.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to IPC input dir
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: _close file — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface KiroAgentConfig {
  name?: unknown;
  mcpServers?: Record<string, unknown>;
  tools?: unknown;
  allowedTools?: unknown;
  resources?: unknown;
}

interface KiroMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  disabled: boolean;
}

// Path resolution: env vars (set by host process runner) or container defaults
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const REAL_HOME = process.env.NANOCLAW_REAL_HOME || process.env.HOME || '';

const IPC_INPUT_DIR = path.join(IPC_BASE_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const KIRO_STEERING_RELATIVE_PREFIX = 'file://.kiro/steering/';
const KIRO_MAIN_STEERING_RESOURCE = 'file://.kiro/steering/Agents.md';
const KIRO_MAIN_STEERING_ABS_SUFFIX = '/groups/main/.kiro/steering/Agents.md';

let activeChild: ChildProcess | null = null;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeOutput(text: string): string {
  const cleaned = stripAnsi(text).replace(/\r/g, '\n');
  const lines = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.includes('Opening browser...'))
    .filter((line) => !line.includes('Press (^) + C to cancel'));

  return lines.join('\n').trim();
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(String(data.text));
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the message text, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function resolveAgentName(): string {
  if (process.env.KIRO_AGENT_NAME && process.env.KIRO_AGENT_NAME.trim()) {
    return process.env.KIRO_AGENT_NAME.trim();
  }

  if (!REAL_HOME) return 'kiro-assistant';

  const configPath = path.join(REAL_HOME, '.kiro', 'agents', 'agent_config.json');
  if (!fs.existsSync(configPath)) return 'kiro-assistant';

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as KiroAgentConfig;
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
  } catch (err) {
    log(`Failed to parse agent config: ${err instanceof Error ? err.message : String(err)}`);
  }

  return 'kiro-assistant';
}

function createSessionId(groupFolder: string): string {
  return `kiro:${groupFolder}`;
}

function ensureArrayStringIncludes(
  value: unknown,
  requiredEntry: string,
): string[] {
  const arr = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  if (!arr.includes(requiredEntry)) arr.push(requiredEntry);
  return arr;
}

function ensureSteeringResource(
  value: unknown,
): string[] {
  const arr = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  const filtered = arr.filter(
    (entry) =>
      !entry.startsWith(KIRO_STEERING_RELATIVE_PREFIX)
      && !entry.endsWith(KIRO_MAIN_STEERING_ABS_SUFFIX),
  );
  if (!filtered.includes(KIRO_MAIN_STEERING_RESOURCE)) {
    filtered.push(KIRO_MAIN_STEERING_RESOURCE);
  }
  return filtered;
}

function ensureNanoclawMcpForKiro(
  input: ContainerInput,
): void {
  if (!REAL_HOME) return;

  const configPath = path.join(REAL_HOME, '.kiro', 'agents', 'agent_config.json');
  if (!fs.existsSync(configPath)) return;

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as KiroAgentConfig;
    const mcpServers = (parsed.mcpServers && typeof parsed.mcpServers === 'object')
      ? parsed.mcpServers
      : {};

    const nanoclawServer: KiroMcpServerConfig = {
      type: 'stdio',
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
      },
      disabled: false,
    };

    mcpServers.nanoclaw = nanoclawServer;
    parsed.mcpServers = mcpServers;
    parsed.tools = ensureArrayStringIncludes(parsed.tools, '@nanoclaw');
    parsed.allowedTools = ensureArrayStringIncludes(parsed.allowedTools, '@nanoclaw');
    parsed.resources = ensureSteeringResource(parsed.resources);

    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
  } catch (err) {
    log(`Failed to ensure NanoClaw MCP in agent config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runKiroChat(
  prompt: string,
  input: ContainerInput,
): Promise<ContainerOutput> {
  ensureNanoclawMcpForKiro(input);
  const agentName = resolveAgentName();
  const hasSession = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0;
  const args: string[] = [
    'chat',
    '--no-interactive',
    '--trust-all-tools',
    '--wrap',
    'never',
    '--agent',
    agentName,
  ];

  if (hasSession) {
    args.push('--resume');
  }

  if (process.env.KIRO_MODEL && process.env.KIRO_MODEL.trim()) {
    args.push('--model', process.env.KIRO_MODEL.trim());
  }

  args.push(prompt);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: REAL_HOME || process.env.HOME,
    NO_COLOR: '1',
    CLICOLOR: '0',
    KIRO_CLI_DISABLE_PAGER: '1',
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    log(`Spawning kiro-cli (agent=${agentName}, new-session=${hasSession ? 'false' : 'true'})`);

    const child = spawn('kiro-cli', args, {
      cwd: GROUP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeChild = child;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_CAPTURE_CHARS) return;
      const next = chunk.toString();
      stdout += next.slice(0, MAX_CAPTURE_CHARS - stdout.length);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_CAPTURE_CHARS) return;
      const next = chunk.toString();
      stderr += next.slice(0, MAX_CAPTURE_CHARS - stderr.length);
    });

    child.on('error', (err) => {
      activeChild = null;
      resolve({
        status: 'error',
        result: null,
        newSessionId: createSessionId(input.groupFolder),
        error: `Failed to start kiro-cli: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      activeChild = null;

      const cleanStdout = normalizeOutput(stdout);
      const cleanStderr = normalizeOutput(stderr);

      if (code === 0) {
        resolve({
          status: 'success',
          result: cleanStdout || null,
          newSessionId: createSessionId(input.groupFolder),
        });
        return;
      }

      const details = cleanStderr || cleanStdout || `kiro-cli exited with code ${String(code)}`;

      resolve({
        status: 'error',
        result: null,
        newSessionId: createSessionId(input.groupFolder),
        error: details.slice(-1000),
      });
    });
  });
}

function setupSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    log(`Received ${signal}`);
    if (activeChild && !activeChild.killed) {
      try {
        activeChild.kill(signal);
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

async function main(): Promise<void> {
  setupSignalHandlers();

  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    // Delete the temp file the entrypoint wrote — it contains secrets
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      // may not exist
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log('Starting Kiro run (new session)');

      const result = await runKiroChat(prompt, containerInput);

      writeOutput({
        status: result.status,
        result: result.result,
        newSessionId: result.newSessionId,
        error: result.error,
      });

      if (result.status === 'error') {
        process.exit(1);
        return;
      }

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting next Kiro run`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: createSessionId(containerInput.groupFolder),
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
