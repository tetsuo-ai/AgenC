/**
 * System tool type definitions.
 *
 * @module
 */

/** Configuration for the bash tool. */
export interface BashToolConfig {
  /** Working directory (default: process.cwd()) */
  readonly cwd?: string;
  /** Command timeout in ms (default: 30000) */
  readonly timeoutMs?: number;
  /** Allowed command prefixes — empty means allow all (subject to deny list) */
  readonly allowList?: readonly string[];
  /** Blocked command prefixes */
  readonly denyList?: readonly string[];
  /** Max output size in bytes (default: 100000) */
  readonly maxOutputBytes?: number;
}

/** Input schema for bash tool execution. */
export interface BashToolInput {
  /** The command to execute (resolved via execFile, not shell) */
  readonly command: string;
  /** Arguments to pass to the command */
  readonly args?: readonly string[];
  /** Working directory override for this execution */
  readonly cwd?: string;
}

/** Structured result from bash tool execution. */
export interface BashToolOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}
