/**
 * Type definitions for system tools.
 *
 * @module
 */

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
 * Default deny list of dangerous commands.
 * Merged with any user-provided deny list.
 */
export const DEFAULT_DENY_LIST: readonly string[] = [
  'rm',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
];

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
