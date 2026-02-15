/**
 * system.bash tool — command execution with allow/deny lists.
 *
 * Uses `child_process.execFile` by default to prevent shell injection.
 * Operators can opt into full shell mode via `useShell: true` in config,
 * which passes `shell: true` to execFile.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';

// ============================================================================
// Types
// ============================================================================

/** Bash tool configuration. */
export interface BashToolConfig {
  /** Working directory (default: process.cwd()). */
  readonly cwd?: string;
  /** Command timeout in ms (default: 30000). */
  readonly timeoutMs?: number;
  /** Allowed command prefixes (empty = allow all that aren't denied). */
  readonly allowList?: readonly string[];
  /** Blocked command prefixes. */
  readonly denyList?: readonly string[];
  /** Max output size in bytes (default: 100000). */
  readonly maxOutputBytes?: number;
  /** Whether to use shell mode (default: false — uses execFile). */
  readonly useShell?: boolean;
}

/** Result of a bash command execution. */
export interface BashExecutionResult {
  /** stdout content. */
  readonly stdout: string;
  /** stderr content. */
  readonly stderr: string;
  /** Exit code (0 = success). */
  readonly exitCode: number;
  /** Whether output was truncated. */
  readonly truncated: boolean;
  /** Whether the command timed out. */
  readonly timedOut: boolean;
  /** Execution duration in ms. */
  readonly durationMs: number;
}

// ============================================================================
// Default deny list
// ============================================================================

/** Default deny list for dangerous commands. */
export const DEFAULT_DENY_LIST: readonly string[] = [
  'rm -rf /',
  'rm -rf ~',
  'dd if=',
  'mkfs',
  'shutdown',
  'reboot',
  ':(){ :|:& };:',
  'curl | sh',
  'wget | sh',
  '> /dev/sda',
];

// ============================================================================
// Command validation
// ============================================================================

/** Check if a command is allowed by allow/deny lists. */
export function isCommandAllowed(
  command: string,
  allowList?: readonly string[],
  denyList?: readonly string[],
): { allowed: boolean; reason?: string } {
  const effectiveDenyList = denyList ?? DEFAULT_DENY_LIST;

  // Deny list checked first (takes precedence)
  for (const pattern of effectiveDenyList) {
    if (command.includes(pattern)) {
      return { allowed: false, reason: `Command matches deny pattern: "${pattern}"` };
    }
  }

  // Allow list: if set, command must match at least one prefix
  if (allowList && allowList.length > 0) {
    const matches = allowList.some((prefix) => command.startsWith(prefix));
    if (!matches) {
      return {
        allowed: false,
        reason: `Command does not match any allow list prefix: ${allowList.join(', ')}`,
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

// ============================================================================
// Tool factory
// ============================================================================

/** Create the system.bash tool. */
export function createBashTool(config?: BashToolConfig): Tool {
  const cwd = config?.cwd ?? process.cwd();
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowList = config?.allowList;
  const denyList = config?.denyList;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const useShell = config?.useShell ?? false;

  return {
    name: 'system.bash',
    description:
      'Execute a shell command on the host system. Commands are validated ' +
      'against allow/deny lists before execution. Uses execFile by default ' +
      '(no shell expansion) for safety.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory override' },
        timeout: { type: 'number', description: 'Timeout override in ms' },
      },
      required: ['command'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const command = args.command;
      if (typeof command !== 'string' || command.trim().length === 0) {
        return {
          content: safeStringify({ error: 'command must be a non-empty string' }),
          isError: true,
        };
      }

      // Check allow/deny lists
      const check = isCommandAllowed(command, allowList, denyList);
      if (!check.allowed) {
        return {
          content: safeStringify({ error: `Command denied: ${check.reason}` }),
          isError: true,
        };
      }

      const effectiveCwd = typeof args.cwd === 'string' ? args.cwd : cwd;
      const effectiveTimeout = typeof args.timeout === 'number' ? args.timeout : timeoutMs;

      const start = Date.now();

      try {
        const result = await executeCommand(
          command,
          effectiveCwd,
          effectiveTimeout,
          maxOutputBytes,
          useShell,
        );

        return {
          content: safeStringify(result),
          isError: result.exitCode !== 0 || result.timedOut,
          metadata: { durationMs: result.durationMs },
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        return {
          content: safeStringify({
            error: err instanceof Error ? err.message : String(err),
            durationMs,
          }),
          isError: true,
        };
      }
    },
  };
}

// ============================================================================
// Internal execution
// ============================================================================

function truncateOutput(output: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(output, 'utf-8');
  if (bytes <= maxBytes) {
    return { text: output, truncated: false };
  }
  const buf = Buffer.from(output, 'utf-8').subarray(0, maxBytes);
  return { text: buf.toString('utf-8') + '\n[truncated]', truncated: true };
}

function executeCommand(
  command: string,
  cwd: string,
  timeout: number,
  maxOutputBytes: number,
  useShell: boolean,
): Promise<BashExecutionResult> {
  return new Promise((resolve) => {
    const start = Date.now();

    const callback = (error: Error | null, stdout: string, stderr: string) => {
      const durationMs = Date.now() - start;

      let timedOut = false;
      let exitCode = 0;

      if (error) {
        const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        timedOut = err.killed === true;

        if (typeof err.code === 'number') {
          exitCode = err.code;
        } else if ('status' in err && typeof (err as Record<string, unknown>).status === 'number') {
          exitCode = (err as Record<string, unknown>).status as number;
        } else {
          exitCode = timedOut ? 124 : 1;
        }
      }

      const stdoutResult = truncateOutput(stdout ?? '', maxOutputBytes);
      const stderrResult = truncateOutput(stderr ?? '', maxOutputBytes);

      resolve({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        exitCode,
        truncated: stdoutResult.truncated || stderrResult.truncated,
        timedOut,
        durationMs,
      });
    };

    if (useShell) {
      // Shell mode: pass command as-is via shell option on execFile.
      // This enables pipes, redirects, and shell builtins.
      // Operators must explicitly opt in via config.
      execFile('/bin/sh', ['-c', command], { cwd, timeout, maxBuffer: maxOutputBytes * 2 }, callback);
    } else {
      // Safe mode: split command and use execFile (no shell expansion)
      const parts = parseCommand(command);
      execFile(parts[0], parts.slice(1), { cwd, timeout, maxBuffer: maxOutputBytes * 2 }, callback);
    }
  });
}

/** Split a command string into [executable, ...args] for execFile. */
function parseCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}
