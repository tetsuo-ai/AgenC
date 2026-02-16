/**
 * Type definitions for system tools.
 *
 * @module
 */

import type { Logger } from '../../utils/logger.js';

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
  /** Allowed command prefixes (empty = allow all) */
  readonly allowList?: readonly string[];
  /** Blocked command prefixes (merged with DEFAULT_DENY_LIST) */
  readonly denyList?: readonly string[];
  /** Max output size in bytes (default: 100_000) */
  readonly maxOutputBytes?: number;
  /** Environment variables to pass to spawned process (default: minimal — PATH only) */
  readonly env?: Record<string, string>;
  /** Logger for execution events and security denials */
  readonly logger?: Logger;
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
  'rm',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  // Shell re-invocation (defeats shell: false security model)
  'bash',
  'sh',
  'zsh',
  'dash',
  'csh',
  'fish',
  // Privilege escalation
  'sudo',
  'su',
  'doas',
  // Process termination
  'kill',
  'killall',
  'pkill',
  // Reverse shells / network tools
  'nc',
  'netcat',
  'ncat',
  // Download-and-execute vectors
  'curl',
  'wget',
  // Script interpreters (can bypass all restrictions)
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  // Environment exfiltration
  'env',
  'printenv',
  // Permission changes
  'chmod',
  'chown',
  'chgrp',
];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
