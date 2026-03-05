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

import { execFile, spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
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
  DANGEROUS_SHELL_PATTERNS,
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
const SHELL_COMMAND_SEPARATORS = new Set([
  "|",
  "||",
  "&&",
  ";",
  "&",
  "(",
  ")",
  "`",
]);
const SHELL_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  "<",
  "<<",
  "<>",
  ">&",
  "<&",
  ">|",
]);
const SHELL_PREFIX_COMMANDS = new Set([
  "command",
  "builtin",
  "exec",
  "time",
  "env",
  "nohup",
  "nice",
  "setsid",
]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

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
 * Validate a shell command against dangerous patterns.
 * Used in shell mode (args omitted) instead of the deny list.
 *
 * @param command - The full shell command string
 * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
 */
export function validateShellCommand(
  command: string,
): { allowed: true } | { allowed: false; reason: string } {
  for (const guard of DANGEROUS_SHELL_PATTERNS) {
    if (guard.pattern.test(command)) {
      return { allowed: false, reason: guard.message };
    }
  }
  return { allowed: true };
}

/** Detect whether a command string requires shell interpretation. */
function isShellModeCommand(
  command: string,
  args: readonly string[] | undefined,
): boolean {
  if (args !== undefined) return false;
  return SHELL_OPERATOR_RE.test(command) || /\s/.test(command);
}

/**
 * Tokenize a shell command string while preserving shell operators.
 * Used to extract executable candidates for policy checks in shell mode.
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  const pushOperator = (operator: string) => {
    pushCurrent();
    tokens.push(operator);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i];
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\\" && i + 1 < command.length) {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\n") {
      pushOperator(";");
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (
      ch === "|" ||
      ch === "&" ||
      ch === ";" ||
      ch === "<" ||
      ch === ">" ||
      ch === "(" ||
      ch === ")" ||
      ch === "`"
    ) {
      const next = command[i + 1] ?? "";
      const pair = ch + next;
      if (
        pair === "||" ||
        pair === "&&" ||
        pair === ">>" ||
        pair === "<<" ||
        pair === ">&" ||
        pair === "<&" ||
        pair === ">|"
      ) {
        pushOperator(pair);
        i += 1;
        continue;
      }
      pushOperator(ch);
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  pushCurrent();

  return tokens;
}

/**
 * Extract executable candidates from a shell command string.
 * We validate every detected executable against deny/allow policy.
 */
function extractShellExecutables(command: string): string[] {
  const tokens = tokenizeShellCommand(command);
  const executables: string[] = [];
  let expectCommand = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (SHELL_COMMAND_SEPARATORS.has(token)) {
      expectCommand = true;
      continue;
    }

    if (!expectCommand) {
      continue;
    }

    // Skip redirection operators and their operands while still waiting for a command.
    if (SHELL_REDIRECT_OPERATORS.has(token)) {
      if (i + 1 < tokens.length) {
        i += 1;
      }
      continue;
    }

    // Handle numeric file-descriptor redirects like `2>/tmp/x`.
    const next = tokens[i + 1];
    if (/^\d+$/.test(token) && next && SHELL_REDIRECT_OPERATORS.has(next)) {
      i += 2;
      continue;
    }

    // Skip environment assignments (`FOO=bar cmd`).
    if (ENV_ASSIGNMENT_RE.test(token)) {
      continue;
    }

    // Skip command-substitution marker tokens.
    if (token === "$") {
      continue;
    }

    // Prefix commands still matter for policy checks, but the actual command follows.
    const lower = token.toLowerCase();
    if (SHELL_PREFIX_COMMANDS.has(lower)) {
      executables.push(token);
      continue;
    }

    executables.push(token);
    expectCommand = false;
  }

  return executables;
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

  // Reject variable-expanded executable names in shell mode (e.g. `$PY` or
  // `$HOME/bin/tool`) because policy checks cannot determine the real binary.
  if (command.startsWith("$") || base.startsWith("$")) {
    return {
      allowed: false,
      reason:
        `Command "${command}" is denied. Variable-expanded executables are not allowed; ` +
        "use an explicit command name/path.",
    };
  }

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
  const shellModeEnabled = config?.shellMode !== false;

  return {
    name: "system.bash",
    description:
      "Execute commands in two modes:\n" +
      '1. **Direct mode** (command + args): Set `command` to a binary (e.g. "git") and `args` to an array of flags/operands. Uses execFile directly.\n' +
      '2. **Shell mode** (command only, no args): Set `command` to a full shell string (e.g. "ls -la | grep foo"). Pipes, redirects, chaining, and backgrounding are supported.',
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Either a single executable name/path (when using `args`) or a full shell command string (when `args` is omitted). " +
            'Examples: "git" (with args: ["status"]) or "cat /tmp/data.json | jq .name" (no args).',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Arguments array for direct mode. When provided, command must be a single executable token. " +
            "Omit this field to use shell mode.",
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

      // Determine execution mode: shell vs direct
      const useShellMode =
        shellModeEnabled && isShellModeCommand(command, input.args);

      let execCommand: string;
      let execArgs: string[];

      if (useShellMode) {
        // Shell mode: validate against dangerous patterns, then run via bash -c
        const shellCheck = validateShellCommand(command);
        if (!shellCheck.allowed) {
          logger.warn(`Bash tool shell-mode denied: ${shellCheck.reason}`);
          return errorResult(shellCheck.reason);
        }

        // Enforce deny/allow policy for each executable discovered in shell mode.
        if (!unrestricted) {
          const shellExecutables = extractShellExecutables(command);
          for (const shellExecutable of shellExecutables) {
            const check = isCommandAllowed(
              shellExecutable,
              denySet,
              allowSet,
              denyExclusionSet,
            );
            if (!check.allowed) {
              logger.warn(`Bash tool shell-mode denied: ${check.reason}`);
              return errorResult(check.reason);
            }
          }
        }

        execCommand = "/bin/bash";
        execArgs = ["-c", command];
      } else {
        // Direct mode: validate command shape, builtins, and deny/allow lists
        if (
          input.args === undefined &&
          shellModeEnabled &&
          !SINGLE_EXECUTABLE_RE.test(command)
        ) {
          // Command has shell operators but shell mode is enabled — this was caught
          // by isShellModeCommand above, so this branch shouldn't be reached.
          // Safety fallback for edge cases.
          return errorResult(
            "Shell mode is disabled. Use `command` + `args` for direct execution.",
          );
        }

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

        execCommand = command;
        execArgs = args;
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

      const logCmd = useShellMode
        ? `[shell] ${command}`
        : `${command} ${execArgs.join(" ")}`;
      logger.debug(`Bash tool executing: ${logCmd}`);
      const startTime = Date.now();

      // Shell mode uses spawn + exit event to avoid hanging when backgrounded
      // children (e.g. `python3 ... &`) inherit stdout/stderr pipes.
      // execFile waits for pipes to close, not just child exit — spawn + exit
      // resolves as soon as bash finishes, leaving backgrounded children running.
      //
      // Commands are written to a temp script file instead of passed via `-c`
      // to prevent pkill -f self-match: when bash runs with `-c <cmd>`,
      // /proc/self/cmdline includes the full command text, so `pkill -f pattern`
      // matches and kills the shell itself. Running from a script file keeps
      // the command text out of the process args.
      if (useShellMode) {
        const scriptId = randomBytes(4).toString("hex");
        const scriptPath = join(tmpdir(), `agenc-sh-${scriptId}.sh`);
        try {
          writeFileSync(scriptPath, command, { mode: 0o700 });
        } catch (writeErr) {
          return errorResult(
            `Failed to create temp script: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
          );
        }

        return new Promise<ToolResult>((resolve) => {
          let resolved = false;
          let stdoutBuf = "";
          let stderrBuf = "";
          let timedOut = false;

          const child = spawn("/bin/bash", [scriptPath], {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true, // Own process group for clean timeout kill
          });

          // Unref so backgrounded grandchildren don't keep Node alive
          child.unref();

          child.stdout!.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
          });
          child.stderr!.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
          });

	          const timer = setTimeout(() => {
	            timedOut = true;
	            // Kill entire process group (bash + any backgrounded children)
	            try {
	              process.kill(-child.pid!, "SIGTERM");
	            } catch (error) {
	              logger.debug("Bash tool process-group SIGTERM failed; falling back to child.kill", {
	                error: error instanceof Error ? error.message : String(error),
	              });
	              child.kill("SIGTERM");
	            }
	            try {
	              unlinkSync(scriptPath);
	            } catch (error) {
	              logger.debug("Bash tool script cleanup failed after timeout", {
	                error: error instanceof Error ? error.message : String(error),
	              });
	            }
	          }, timeout);

	          const doResolve = (code: number | null) => {
	            if (resolved) return;
	            resolved = true;
	            clearTimeout(timer);
	            try {
	              unlinkSync(scriptPath);
	            } catch (error) {
	              logger.debug("Bash tool script cleanup failed on resolve", {
	                error: error instanceof Error ? error.message : String(error),
	              });
	            }

            const durationMs = Date.now() - startTime;
            const exitCode = timedOut ? null : (code ?? 1);
            const isError = timedOut || (exitCode !== null && exitCode !== 0);

            const stdoutResult = truncate(stdoutBuf, maxOutputBytes);
            const stderrResult = truncate(
              stderrBuf.trim().length > 0
                ? stderrBuf
                : isError
                  ? `Command "${command}" failed`
                  : "",
              maxOutputBytes,
            );

            if (timedOut) {
              logger.warn(
                `Bash tool timed out after ${durationMs}ms: ${logCmd}`,
              );
            } else if (isError) {
              logger.debug(
                `Bash tool error (exit ${exitCode}): ${logCmd}`,
              );
            } else {
              logger.debug(`Bash tool success (${durationMs}ms): ${logCmd}`);
            }

            const result: BashExecutionResult = {
              exitCode,
              stdout: stdoutResult.text,
              stderr: stderrResult.text,
              timedOut,
              durationMs,
              truncated: stdoutResult.truncated || stderrResult.truncated,
            };

            resolve({
              content: safeStringify(result),
              isError: isError || undefined,
              metadata: {
                command,
                args: execArgs,
                cwd,
                shellMode: true,
                timedOut,
                durationMs,
              },
            });
          };

          // Resolve on exit (NOT close) — close waits for pipes,
          // exit fires when bash process terminates.
          child.on("exit", (code) => {
            // Brief delay to flush any remaining pipe data from bash itself
            setTimeout(() => doResolve(code), 50);
          });

	          child.on("error", (err) => {
	            if (resolved) return;
	            resolved = true;
	            clearTimeout(timer);
	            try {
	              unlinkSync(scriptPath);
	            } catch (error) {
	              logger.debug("Bash tool script cleanup failed on child error", {
	                error: error instanceof Error ? error.message : String(error),
	              });
	            }
	            const durationMs = Date.now() - startTime;
            resolve({
              content: safeStringify({
                error: err.message,
                exitCode: null,
                stdout: "",
                stderr: err.message,
                timedOut: false,
                durationMs,
                truncated: false,
              }),
              isError: true,
              metadata: {
                command,
                args: execArgs,
                cwd,
                shellMode: true,
                durationMs,
              },
            });
          });
        });
      }

      // Direct mode: use execFile (waits for pipes — safe since no backgrounding)
      return new Promise<ToolResult>((resolve) => {
        execFile(
          execCommand,
          execArgs,
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
                  `Bash tool timed out after ${durationMs}ms: ${logCmd}`,
                );
              } else {
                logger.debug(
                  `Bash tool error (exit ${exitCode}): ${logCmd}`,
                );
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
                  args: execArgs,
                  cwd,
                  shellMode: false,
                  timedOut: isTimeout,
                  durationMs,
                },
              });
              return;
            }

            const stdoutResult = truncate(toText(stdout), maxOutputBytes);
            const stderrResult = truncate(toText(stderr), maxOutputBytes);

            logger.debug(`Bash tool success (${durationMs}ms): ${logCmd}`);

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
              metadata: {
                command,
                args: execArgs,
                cwd,
                shellMode: false,
                durationMs,
              },
            });
          },
        );
      });
    },
  };
}
