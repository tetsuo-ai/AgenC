/**
 * Bash tool — secure command execution for LLM agents.
 *
 * Uses `child_process.execFile()` (NOT `exec()`) to prevent shell injection.
 * Commands are validated against allow/deny lists before execution.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';
import type { BashToolConfig, BashToolInput } from './types.js';
import {
  DEFAULT_DENY_LIST,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from './types.js';

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf-8');
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n[truncated]';
}

function buildDenySet(configDenyList?: readonly string[]): Set<string> {
  const set = new Set<string>(DEFAULT_DENY_LIST);
  if (configDenyList) {
    for (const cmd of configDenyList) {
      set.add(cmd);
    }
  }
  return set;
}

/**
 * Create the system.bash tool.
 *
 * @param config - Optional configuration for cwd, timeouts, and allow/deny lists
 * @returns A Tool instance that executes bash commands securely
 */
export function createBashTool(config?: BashToolConfig): Tool {
  const denySet = buildDenySet(config?.denyList);
  const allowSet = config?.allowList && config.allowList.length > 0
    ? new Set<string>(config.allowList)
    : null;
  const defaultCwd = config?.cwd ?? process.cwd();
  const defaultTimeout = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    name: 'system.bash',
    description:
      'Execute a command. The command argument is the executable name (e.g. "ls", "git"), ' +
      'and args is an array of arguments. Shell expansion is disabled for security.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Executable name (e.g. "ls", "git", "node")',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments array',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (optional override)',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (optional override)',
        },
      },
      required: ['command'],
    },

    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as unknown as BashToolInput;

      // Validate command
      if (typeof input.command !== 'string' || input.command.trim().length === 0) {
        return errorResult('command must be a non-empty string');
      }

      const command = input.command.trim();

      // Check deny list
      if (denySet.has(command)) {
        return errorResult(`Command "${command}" is denied`);
      }

      // Check allow list
      if (allowSet && !allowSet.has(command)) {
        return errorResult(`Command "${command}" is not in the allow list`);
      }

      // Validate args
      const args: string[] = [];
      if (input.args !== undefined) {
        if (!Array.isArray(input.args)) {
          return errorResult('args must be an array of strings');
        }
        for (const arg of input.args) {
          if (typeof arg !== 'string') {
            return errorResult('Each argument must be a string');
          }
          args.push(arg);
        }
      }

      const cwd = input.cwd ?? defaultCwd;
      const timeout = input.timeoutMs ?? defaultTimeout;

      return new Promise<ToolResult>((resolve) => {
        execFile(
          command,
          args,
          {
            cwd,
            timeout,
            maxBuffer: maxOutputBytes,
            shell: false,
          },
          (error, stdout, stderr) => {
            if (error) {
              const isTimeout = error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
              const exitCode = error.code != null && typeof error.code === 'number'
                ? error.code
                : (isTimeout ? null : 1);

              resolve({
                content: safeStringify({
                  exitCode,
                  stdout: truncate(stdout ?? '', maxOutputBytes),
                  stderr: truncate(stderr ?? error.message, maxOutputBytes),
                  timedOut: isTimeout,
                }),
                isError: true,
                metadata: { command, args, cwd, timedOut: isTimeout },
              });
              return;
            }

            resolve({
              content: safeStringify({
                exitCode: 0,
                stdout: truncate(stdout, maxOutputBytes),
                stderr: truncate(stderr, maxOutputBytes),
              }),
              metadata: { command, args, cwd },
            });
          },
        );
      });
    },
  };
}
