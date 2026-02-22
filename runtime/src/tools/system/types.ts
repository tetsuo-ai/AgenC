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
}

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
