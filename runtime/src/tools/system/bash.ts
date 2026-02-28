/**
 * Bash tool — secure command execution for LLM agents.
 *
 * Uses `child_process.execFile()` (NOT `exec()`) to prevent shell injection.
 * Commands are validated against allow/deny lists before execution.
 * Deny list checks both the raw command and its basename to prevent
 * absolute-path bypasses (e.g. `/bin/rm` vs `rm`).
 *
 * @module
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type {
  BashToolConfig,
  BashToolInput,
  BashExecutionResult,
} from "./types.js";
import {
  DEFAULT_DENY_LIST,
  DEFAULT_DENY_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./types.js";
import { silentLogger } from "../../utils/logger.js";
import type { Logger } from "../../utils/logger.js";

const SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "fish",
  "ksh",
  "tcsh",
]);
const SHELL_BUILTIN_COMMANDS = new Set([
  "set",
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "unset",
  "shopt",
  "ulimit",
  "umask",
  "readonly",
  "declare",
  "typeset",
  "builtin",
]);
const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./+-]+$/;
const SHELL_OPERATOR_RE = /[|&;<>()`$\\\r\n]/;

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function validateCommandShape(command: string): string | undefined {
  if (command.length === 0) {
    return "command must be a non-empty string";
  }
  if (SHELL_OPERATOR_RE.test(command)) {
    return (
      `Invalid command "${command}". Shell operators/newlines are not allowed in \`command\`. ` +
      "Use a direct executable plus args instead."
    );
  }
  if (/\s/.test(command)) {
    return (
      `Invalid command "${command}". system.bash expects one executable token in \`command\` ` +
      `(for example "ls" or "/usr/bin/git"). Put flags and operands in \`args\`.`
    );
  }
  if (!SINGLE_EXECUTABLE_RE.test(command)) {
    return (
      `Invalid command "${command}". Use a direct executable path/name ` +
      'matching `[A-Za-z0-9_./+-]+` and pass flags via `args`.'
    );
  }
  return undefined;
}

function validateShellBuiltin(command: string): string | undefined {
  const base = basename(command).toLowerCase();
  if (!SHELL_BUILTIN_COMMANDS.has(base)) {
    return undefined;
  }

  return (
    `Invalid command "${command}". "${base}" is a shell builtin, not a standalone executable. ` +
    "system.bash runs one executable directly. Use a real binary in `command` with `args`, " +
    "or use `desktop.bash` for shell-style scripts/heredocs/chaining."
  );
}

function truncate(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes)
    return { text, truncated: false };
  const buf = Buffer.from(text, "utf-8");
  const truncatedText = buf.subarray(0, maxBytes).toString("utf-8");
  return { text: truncatedText + "\n[truncated]", truncated: true };
}

function buildDenySet(
  configDenyList?: readonly string[],
  denyExclusions?: readonly string[],
): Set<string> {
  const set = new Set<string>(DEFAULT_DENY_LIST);
  if (configDenyList) {
    for (const cmd of configDenyList) {
      set.add(cmd);
    }
  }
  if (denyExclusions) {
    for (const cmd of denyExclusions) {
      set.delete(cmd);
    }
  }
  return set;
}

/**
 * Check if a command basename matches any deny prefix.
 * Catches version-specific binaries like python3.11, pypy3, nodejs18, etc.
 */
function matchesDenyPrefix(base: string): boolean {
  const lower = base.toLowerCase();
  return DEFAULT_DENY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Build a minimal environment for spawned processes.
 * Only exposes PATH by default to prevent secret exfiltration.
 */
function buildEnv(configEnv?: Record<string, string>): Record<string, string> {
  if (configEnv) return configEnv;
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
  };
}

/**
 * Check if a command is allowed by the allow/deny list rules.
 *
 * Rules:
 * 1. Deny list is checked first (deny takes precedence over allow)
 * 2. Both the raw command and its basename are checked against the deny set
 * 3. Deny prefixes catch version-specific binaries (e.g. python3.11, pypy3)
 * 4. If an allow list is provided, the command must appear in it
 *
 * @param command - The command string to check
 * @param denySet - Set of denied command names
 * @param allowSet - Optional set of allowed command names (null = allow all)
 * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
 */
export function isCommandAllowed(
  command: string,
  denySet: ReadonlySet<string>,
  allowSet: ReadonlySet<string> | null,
  denyExclusions?: ReadonlySet<string> | null,
): { allowed: true } | { allowed: false; reason: string } {
  const base = basename(command);
  const exclusionSet = denyExclusions ?? null;
  const isExcluded =
    exclusionSet !== null &&
    (exclusionSet.has(command) || exclusionSet.has(base));

  // Exact deny list takes precedence
  if (!isExcluded && (denySet.has(command) || denySet.has(base))) {
    if (SHELL_WRAPPER_COMMANDS.has(base)) {
      return {
        allowed: false,
        reason:
          `Command "${command}" is denied. Do not use shell wrappers like "bash -c". ` +
          `Call the executable directly with \`command\` + \`args\` (e.g. \`command:"curl", args:["-sSf","http://..."]\`). ` +
          `For multi-step logic, write a script file and execute that file path directly.`,
      };
    }
    return { allowed: false, reason: `Command "${command}" is denied` };
  }

  // Prefix deny list catches version-specific binaries (python3.11, pypy3, etc.)
  if (!isExcluded && matchesDenyPrefix(base)) {
    return {
      allowed: false,
      reason: `Command "${command}" is denied (matches deny prefix)`,
    };
  }

  // Allow list check
  if (allowSet && !allowSet.has(command) && !allowSet.has(base)) {
    return {
      allowed: false,
      reason: `Command "${command}" is not in the allow list`,
    };
  }

  return { allowed: true };
}

/**
 * Create the system.bash tool.
 *
 * @param config - Optional configuration for cwd, timeouts, and allow/deny lists
 * @returns A Tool instance that executes bash commands securely
 */
export function createBashTool(config?: BashToolConfig): Tool {
  const unrestricted = config?.unrestricted ?? false;
  const denySet = unrestricted
    ? new Set<string>()
    : buildDenySet(config?.denyList, config?.denyExclusions);
  const allowSet =
    !unrestricted && config?.allowList && config.allowList.length > 0
      ? new Set<string>(config.allowList)
      : null;
  const denyExclusionSet =
    !unrestricted && config?.denyExclusions && config.denyExclusions.length > 0
      ? new Set<string>(config.denyExclusions)
      : null;
  const defaultCwd = config?.cwd ?? process.cwd();
  const defaultTimeout = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = config?.maxTimeoutMs ?? defaultTimeout;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = buildEnv(config?.env);
  const logger: Logger = config?.logger ?? silentLogger;
  const lockCwd = config?.lockCwd ?? false;

  return {
    name: "system.bash",
    description:
      'Execute one executable directly (no shell). Set `command` to the binary name (e.g. "ls", "git") ' +
      "and `args` to an array of arguments. Do NOT use shell wrappers like `bash -c` or shell operators (pipes, redirects, heredocs) as command text.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          pattern: "^[A-Za-z0-9_./+-]+$",
          description:
            'Executable token/path only (e.g. "ls", "/usr/bin/git", "curl"). No spaces/newlines/shell operators. Do not pass "bash -c ..." or combined shell strings.',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments array",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional override)",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (optional override)",
        },
      },
      required: ["command"],
    },

    async execute(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      const input = rawArgs as unknown as BashToolInput;

      // Validate command
      if (
        typeof input.command !== "string" ||
        input.command.trim().length === 0
      ) {
        return errorResult("command must be a non-empty string");
      }

      const command = input.command.trim();
      const commandShapeError = validateCommandShape(command);
      if (commandShapeError) {
        return errorResult(commandShapeError);
      }
      const shellBuiltinError = validateShellBuiltin(command);
      if (shellBuiltinError) {
        return errorResult(shellBuiltinError);
      }

      // Check deny/allow lists (skipped in unrestricted mode)
      if (!unrestricted) {
        const check = isCommandAllowed(
          command,
          denySet,
          allowSet,
          denyExclusionSet,
        );
        if (!check.allowed) {
          logger.warn(`Bash tool denied: ${check.reason}`);
          return errorResult(check.reason);
        }
      }

      // Validate args
      const args: string[] = [];
      if (input.args !== undefined) {
        if (!Array.isArray(input.args)) {
          return errorResult("args must be an array of strings");
        }
        for (const arg of input.args) {
          if (typeof arg !== "string") {
            return errorResult("Each argument must be a string");
          }
          args.push(arg);
        }
      }

      // Apply cwd — reject per-call override if lockCwd is enabled
      let cwd = defaultCwd;
      if (input.cwd !== undefined) {
        if (lockCwd) {
          return errorResult(
            "Per-call cwd override is disabled (lockCwd is enabled)",
          );
        }
        cwd = input.cwd;
      }

      // Apply timeout — cap at maxTimeoutMs to prevent LLM from setting arbitrarily high values
      const timeout = Math.min(input.timeoutMs ?? defaultTimeout, maxTimeoutMs);

      logger.debug(`Bash tool executing: ${command} ${args.join(" ")}`);
      const startTime = Date.now();

      return new Promise<ToolResult>((resolve) => {
        execFile(
          command,
          args,
          {
            cwd,
            timeout,
            maxBuffer: maxOutputBytes * 2, // Allow headroom, rely on truncate() for user-facing limits
            shell: false,
            env,
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - startTime;

            if (error) {
              const isTimeout =
                error.killed ||
                (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
              const exitCode =
                error.code != null && typeof error.code === "number"
                  ? error.code
                  : isTimeout
                    ? null
                    : 1;

              const stdoutText = toText(stdout);
              const stderrText = toText(stderr);
              const fallbackErrorText =
                error.message || `Command "${command}" failed`;

              const stdoutResult = truncate(stdoutText, maxOutputBytes);
              const stderrResult = truncate(
                stderrText.trim().length > 0 ? stderrText : fallbackErrorText,
                maxOutputBytes,
              );

              if (isTimeout) {
                logger.warn(
                  `Bash tool timed out after ${durationMs}ms: ${command}`,
                );
              } else {
                logger.debug(`Bash tool error (exit ${exitCode}): ${command}`);
              }

              const result: BashExecutionResult = {
                exitCode,
                stdout: stdoutResult.text,
                stderr: stderrResult.text,
                timedOut: isTimeout,
                durationMs,
                truncated: stdoutResult.truncated || stderrResult.truncated,
              };

              resolve({
                content: safeStringify(result),
                isError: true,
                metadata: {
                  command,
                  args,
                  cwd,
                  timedOut: isTimeout,
                  durationMs,
                },
              });
              return;
            }

            const stdoutResult = truncate(toText(stdout), maxOutputBytes);
            const stderrResult = truncate(toText(stderr), maxOutputBytes);

            logger.debug(`Bash tool success (${durationMs}ms): ${command}`);

            const result: BashExecutionResult = {
              exitCode: 0,
              stdout: stdoutResult.text,
              stderr: stderrResult.text,
              timedOut: false,
              durationMs,
              truncated: stdoutResult.truncated || stderrResult.truncated,
            };

            resolve({
              content: safeStringify(result),
              metadata: { command, args, cwd, durationMs },
            });
          },
        );
      });
    },
  };
}
