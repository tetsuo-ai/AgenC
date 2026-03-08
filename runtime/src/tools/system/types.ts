/**
 * Type definitions for system tools.
 *
 * @module
 */

import type { Logger } from "../../utils/logger.js";

// ============================================================================
// Bash tool types
// ============================================================================

/**
 * Configuration for the bash tool.
 */
export interface BashToolConfig {
  /** Working directory (default: process.cwd()) */
  readonly cwd?: string;
  /** Command timeout in ms (default: 30_000) */
  readonly timeoutMs?: number;
  /** Maximum timeout the LLM can request per-call in ms. Caps per-call timeoutMs overrides. */
  readonly maxTimeoutMs?: number;
  /** Allowed command prefixes (empty = allow all) */
  readonly allowList?: readonly string[];
  /** Blocked command prefixes (merged with DEFAULT_DENY_LIST) */
  readonly denyList?: readonly string[];
  /** Commands to remove from the deny list (overrides DEFAULT_DENY_LIST entries) */
  readonly denyExclusions?: readonly string[];
  /** Max output size in bytes (default: 100_000) */
  readonly maxOutputBytes?: number;
  /** Environment variables to pass to spawned process (default: minimal — PATH only) */
  readonly env?: Record<string, string>;
  /** Logger for execution events and security denials */
  readonly logger?: Logger;
  /** Lock working directory — reject per-call cwd overrides from LLM (default: false) */
  readonly lockCwd?: boolean;
  /** Disable all deny lists (default + config). Use for trusted daemon environments. (default: false) */
  readonly unrestricted?: boolean;
  /** Enable shell mode when args is omitted (default: true). Set false to require command+args only. */
  readonly shellMode?: boolean;
}

/**
 * Configuration for durable host-managed process tools.
 */
export interface SystemProcessToolConfig {
  /** Durable registry/log root directory. */
  readonly rootDir?: string;
  /** Default working directory. */
  readonly cwd?: string;
  /** Lock working directory — reject per-call cwd overrides. */
  readonly lockCwd?: boolean;
  /** Environment variables exposed to managed processes. */
  readonly env?: Record<string, string>;
  /** Allowed executable names/paths (empty = allow all except deny rules). */
  readonly allowList?: readonly string[];
  /** Blocked executable names/paths. */
  readonly denyList?: readonly string[];
  /** Executables removed from the deny set. */
  readonly denyExclusions?: readonly string[];
  /** Disable allow/deny enforcement for trusted environments. */
  readonly unrestricted?: boolean;
  /** Default recent-log bytes returned by status/logs. */
  readonly defaultLogTailBytes?: number;
  /** Maximum recent-log bytes allowed per call. */
  readonly maxLogTailBytes?: number;
  /** Default graceful stop wait window in milliseconds. */
  readonly defaultStopWaitMs?: number;
  /** Logger for lifecycle and failure events. */
  readonly logger?: Logger;
  /** Time source override used by tests. */
  readonly now?: () => number;
}

// ============================================================================
// Shell mode safety types
// ============================================================================

/**
 * A pattern that blocks dangerous shell commands in shell mode.
 */
export interface DangerousShellPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * Dangerous shell patterns checked in shell mode.
 * These catch dangerous operations regardless of how they're expressed
 * (pipes, subshells, aliases, etc.).
 */
export const DANGEROUS_SHELL_PATTERNS: readonly DangerousShellPattern[] = [
  {
    name: "privilege_escalation",
    pattern: /\b(?:sudo|su|doas)\b/,
    message: "Privilege escalation commands (sudo/su/doas) are blocked",
  },
  {
    name: "root_filesystem_destruction",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?(\/\s*$|\/\*|~\/)/,
    message: "Recursive deletion of root or home directory is blocked",
  },
  {
    name: "reverse_shell",
    pattern: /(?:\bnc\b.*-[a-zA-Z]*e|\/dev\/tcp\/|\bsocat\b.*\bexec\b)/,
    message: "Reverse shell patterns are blocked",
  },
  {
    name: "download_and_execute",
    pattern: /(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/,
    message: "Download-and-execute (pipe to shell) is blocked",
  },
  {
    name: "system_commands",
    pattern: /\b(?:shutdown|reboot|halt|poweroff|mkfs)\b/,
    message: "Destructive system commands are blocked",
  },
  {
    name: "raw_device_access",
    pattern: /\bdd\b[^|]*\bof=\/dev\//,
    message: "Raw device writes via dd are blocked",
  },
  {
    name: "shell_reinvocation",
    pattern: /\b(?:bash|sh|zsh|dash)\s+-c\b/,
    message: "Nested shell invocation (bash -c) is blocked — write your command directly",
  },
  {
    name: "fork_bomb",
    pattern: /:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/,
    message: "Fork bomb patterns are blocked",
  },
];

/**
 * Input schema for a bash tool invocation.
 */
export interface BashToolInput {
  /** Executable name (e.g. "ls", "git", "node") */
  readonly command: string;
  /** Arguments array passed to execFile */
  readonly args?: readonly string[];
  /** Per-call working directory override */
  readonly cwd?: string;
  /** Per-call timeout override in ms */
  readonly timeoutMs?: number;
}

/**
 * Result of a bash tool execution.
 */
export interface BashExecutionResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly truncated: boolean;
}

/**
 * Default deny list of dangerous commands.
 * Blocks shell re-invocation, privilege escalation, destructive ops,
 * reverse shells, download-and-execute, and script interpreters.
 * Merged with any user-provided deny list.
 */
export const DEFAULT_DENY_LIST: readonly string[] = [
  // Destructive operations
  "rm",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  // Shell re-invocation (defeats shell: false security model)
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "fish",
  "ksh",
  "tcsh",
  // Privilege escalation
  "sudo",
  "su",
  "doas",
  // Process termination
  "kill",
  "killall",
  "pkill",
  // Reverse shells / network tools
  "nc",
  "netcat",
  "ncat",
  "socat",
  // Download-and-execute vectors
  "curl",
  "wget",
  // Network access / data exfiltration
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  // Script interpreters (can bypass all restrictions)
  "python",
  "python3",
  "node",
  "nodejs",
  "perl",
  "ruby",
  "php",
  "lua",
  "deno",
  "bun",
  "tclsh",
  // Command execution wrappers
  "xargs",
  "env",
  "nohup",
  // Dangerous text processing (can write files / execute commands)
  "awk",
  "gawk",
  "nawk",
  // Environment exfiltration
  "printenv",
  // Permission changes
  "chmod",
  "chown",
  "chgrp",
  // File writing via non-obvious tools
  "tee",
  "install",
  // Process inspection / debugging
  "strace",
  "ltrace",
  "gdb",
  // Filesystem manipulation
  "mount",
  "umount",
  // Scheduled execution
  "crontab",
  "at",
];

/**
 * Deny list prefixes for version-specific interpreter binaries.
 * E.g. "python3.11", "python3.12", "pypy3", "nodejs18".
 * Checked via `basename.startsWith(prefix)` in addition to exact deny set matches.
 */
export const DEFAULT_DENY_PREFIXES: readonly string[] = [
  "python",
  "pypy",
  "ruby",
  "perl",
  "php",
  "lua",
  "node",
];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
