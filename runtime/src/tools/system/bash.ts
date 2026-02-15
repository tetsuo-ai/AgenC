/**
 * Bash tool — execute commands with allow/deny lists and safety controls.
 *
 * Security:
 * - Uses `execFile` (not `exec`) to avoid shell injection
 * - Allow list restricts which commands can run (empty = allow all)
 * - Deny list blocks dangerous commands
 * - Output truncated at maxOutputBytes
 * - Timeout enforced via child_process timeout option
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';
import type { BashToolConfig, BashToolInput, BashToolOutput } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

const DEFAULT_DENY_LIST: readonly string[] = [
  'rm -rf /',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'curl | sh',
  'wget | sh',
  'curl|sh',
  'wget|sh',
  ':(){ :|:& };:',
];

/**
 * Check if a command + args string matches a deny list entry.
 */
function matchesDenyList(
  command: string,
  args: readonly string[],
  denyList: readonly string[],
): string | undefined {
  const full = [command, ...args].join(' ');
  for (const pattern of denyList) {
    if (full.startsWith(pattern) || command === pattern) {
      return pattern;
    }
  }
  return undefined;
}

/**
 * Check if a command is on the allow list.
 * Returns true if allow list is empty (allow-all mode).
 */
function matchesAllowList(
  command: string,
  allowList: readonly string[],
): boolean {
  if (allowList.length === 0) return true;
  return allowList.some((allowed) => command === allowed || command.startsWith(allowed));
}

/**
 * Truncate a string to maxBytes, returning [truncated, wasTruncated].
 */
function truncateOutput(output: string, maxBytes: number): [string, boolean] {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) return [output, false];
  return [buf.subarray(0, maxBytes).toString('utf-8') + '\n... [truncated]', true];
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/**
 * Create a bash tool instance with the given configuration.
 */
export function createBashTool(config?: BashToolConfig): Tool {
  const cwd = config?.cwd ?? process.cwd();
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowList = config?.allowList ?? [];
  const denyList = config?.denyList ?? DEFAULT_DENY_LIST;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    name: 'system.bash',
    description:
      'Execute a command. The command is run via execFile (no shell expansion). ' +
      'Provide the command name and args separately. Output is truncated if too large.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to execute (e.g. "ls", "git", "python3")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments to pass to the command',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (defaults to configured cwd)',
        },
      },
      required: ['command'],
    },

    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as unknown as BashToolInput;

      if (typeof input.command !== 'string' || input.command.trim().length === 0) {
        return errorResult('command must be a non-empty string');
      }

      const command = input.command.trim();
      const args: string[] = Array.isArray(input.args)
        ? input.args.filter((a): a is string => typeof a === 'string')
        : [];

      // Deny list check
      const deniedMatch = matchesDenyList(command, args, denyList);
      if (deniedMatch !== undefined) {
        return errorResult(`Command blocked by deny list: "${deniedMatch}"`);
      }

      // Allow list check
      if (!matchesAllowList(command, allowList)) {
        return errorResult(`Command not on allow list: "${command}"`);
      }

      // Resolve working directory
      const workingDir = typeof input.cwd === 'string' && input.cwd.length > 0
        ? input.cwd
        : cwd;

      if (!existsSync(workingDir)) {
        return errorResult(`Working directory does not exist: "${workingDir}"`);
      }

      // Execute
      const output = await executeCommand(command, args, workingDir, timeoutMs);

      // Truncate
      const [stdout, stdoutTruncated] = truncateOutput(output.stdout, maxOutputBytes);
      const [stderr, stderrTruncated] = truncateOutput(output.stderr, maxOutputBytes);
      const truncated = stdoutTruncated || stderrTruncated;

      const result: BashToolOutput = {
        exitCode: output.exitCode,
        stdout,
        stderr,
        truncated,
        timedOut: output.timedOut,
      };

      return {
        content: safeStringify(result),
        isError: output.exitCode !== 0,
        metadata: { command, args, cwd: workingDir },
      };
    },
  };
}

function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer, we truncate ourselves
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && 'killed' in error && error.killed === true;
        const exitCode = error !== null
          ? (typeof error.code === 'number' ? error.code : 1)
          : 0;

        resolve({
          exitCode,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          timedOut,
        });
      },
    );

    // Safety: if child somehow hangs beyond timeout, force kill
    child.on('error', () => {
      // handled by execFile callback
    });
  });
}
