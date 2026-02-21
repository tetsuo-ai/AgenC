/**
 * Docker-based execution sandboxing for @agenc/runtime.
 *
 * Provides isolated container environments for tool execution with configurable
 * resource limits, workspace mounting, and network access control. Three modes:
 * - `off`      — commands run on the host (no sandboxing)
 * - `non-main` — group/thread scopes are sandboxed, DMs run on host
 * - `all`      — all scopes are sandboxed
 *
 * Docker is NOT a required dependency — the module gracefully degrades when
 * Docker is unavailable.
 *
 * @module
 */

import { execFile, type ExecFileException } from "node:child_process";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Promise wrapper for `execFile` that returns `{ stdout, stderr }`.
 *
 * We use a manual wrapper instead of `util.promisify(execFile)` because
 * Node's custom promisify for execFile returns a ChildProcess with `.then()`,
 * which complicates test mocking.
 */
function execFileAsync(
  cmd: string,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      opts,
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          // Attach stdout/stderr to the error for non-zero exit code handling
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

// ============================================================================
// Constants
// ============================================================================

/** Default Docker image used for sandbox containers. */
export const DEFAULT_IMAGE = "node:20-slim";

/** Default memory limit for sandbox containers. */
export const DEFAULT_MAX_MEMORY = "512m";

/** Default CPU limit for sandbox containers. */
export const DEFAULT_MAX_CPU = "1.0";

/** Default timeout for Docker daemon commands (info, run, rm) in ms. */
export const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;

/** Default timeout for command execution inside the container in ms. */
export const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;

/** Default maximum output bytes before truncation (100KB, matching bash tool). */
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;

/** Prefix for all AgenC sandbox container names. */
export const CONTAINER_PREFIX = "agenc-sandbox";

// ============================================================================
// Error classes
// ============================================================================

export class SandboxExecutionError extends RuntimeError {
  public readonly command: string;
  public readonly cause: unknown;

  constructor(command: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(
      `Sandbox execution failed for command "${command}": ${msg}`,
      RuntimeErrorCodes.SANDBOX_EXECUTION_ERROR,
    );
    this.name = "SandboxExecutionError";
    this.command = command;
    this.cause = cause;
  }
}

export class SandboxUnavailableError extends RuntimeError {
  public readonly cause: unknown;

  constructor(cause?: unknown) {
    const msg =
      cause instanceof Error
        ? cause.message
        : cause
          ? String(cause)
          : "Docker is not available";
    super(msg, RuntimeErrorCodes.SANDBOX_UNAVAILABLE);
    this.name = "SandboxUnavailableError";
    this.cause = cause;
  }
}

// ============================================================================
// Types
// ============================================================================

/** Sandboxing mode controlling which scopes are isolated. */
export type SandboxMode = "off" | "non-main" | "all";

/**
 * Scope granularity for container isolation.
 * - `session` — one container per session ID
 * - `agent`   — one container per agent (shared across sessions)
 * - `shared`  — single shared container for all executions
 */
export type SandboxScope = "session" | "agent" | "shared";

/** Workspace directory access mode inside the container. */
export type WorkspaceAccessMode = "none" | "readonly" | "readwrite";

/** Configuration for the sandbox manager. */
export interface SandboxConfig {
  /** Sandboxing mode. Default: `'off'`. */
  readonly mode: SandboxMode;
  /** Container isolation scope. Default: `'session'`. */
  readonly scope: SandboxScope;
  /** Docker image to use. Default: `'node:20-slim'`. */
  readonly image?: string;
  /** Memory limit (Docker format, e.g. `'512m'`). Default: `'512m'`. */
  readonly maxMemory?: string;
  /** CPU limit (e.g. `'1.0'`). Default: `'1.0'`. */
  readonly maxCpu?: string;
  /** Whether containers have network access. Default: `false`. */
  readonly networkAccess?: boolean;
  /** How the host workspace is mounted into the container. Default: `'none'`. */
  readonly workspaceAccess?: WorkspaceAccessMode;
  /** Shell script to run inside the container after creation (e.g. `apt-get install -y jq`). */
  readonly setupScript?: string;
}

/** Result of executing a command inside a sandbox container. */
export interface SandboxResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Whether stdout or stderr was truncated due to size limits. */
  readonly truncated: boolean;
}

/** Options for a single sandbox execution. */
export interface SandboxExecuteOptions {
  /** Session ID for container scoping. Default: `'default'`. */
  readonly sessionId?: string;
  /** Execution timeout in ms. Default: `DEFAULT_EXECUTE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Working directory inside the container. */
  readonly cwd?: string;
  /** Environment variables to pass to the command. */
  readonly env?: Record<string, string>;
}

// ============================================================================
// Helpers
// ============================================================================

/** Returns a safe default sandbox configuration (sandboxing disabled). */
export function defaultSandboxConfig(): SandboxConfig {
  return {
    mode: "off",
    scope: "session",
    workspaceAccess: "none",
    networkAccess: false,
  };
}

/**
 * Checks whether Docker is available on the host.
 *
 * Runs `docker info` with a timeout. Returns `true` if Docker responds
 * successfully, `false` otherwise. Does not cache results.
 */
export async function checkDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], {
      timeout: DEFAULT_DOCKER_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// SandboxManager
// ============================================================================

/**
 * Manages Docker container lifecycle for sandboxed command execution.
 *
 * Containers are lazily created on first execution and reused for the lifetime
 * of the session (or agent/shared scope). The manager tracks containers via
 * a `Map<string, Promise<string>>` to prevent race conditions when concurrent
 * calls request the same container.
 */
export class SandboxManager {
  private readonly config: SandboxConfig;
  private readonly workspacePath: string | undefined;
  private readonly dockerTimeoutMs: number;
  private readonly logger: Logger;

  /** scope key → Promise resolving to container ID */
  private readonly containers = new Map<string, Promise<string>>();

  /** Cached Docker availability check (null = not yet checked). */
  private dockerAvailable: boolean | null = null;

  constructor(
    config: SandboxConfig,
    options?: {
      workspacePath?: string;
      dockerTimeoutMs?: number;
      logger?: Logger;
    },
  ) {
    this.config = config;
    this.workspacePath = options?.workspacePath;
    this.dockerTimeoutMs =
      options?.dockerTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
    this.logger = options?.logger ?? silentLogger;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Checks whether Docker is available. Result is cached after first call.
   * Never throws.
   */
  async isAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }
    try {
      await execFileAsync("docker", ["info"], {
        timeout: this.dockerTimeoutMs,
      });
      this.dockerAvailable = true;
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  /**
   * Determines whether the given message scope should be sandboxed based on
   * the current mode configuration. Pure synchronous check.
   */
  shouldSandbox(scope: "dm" | "group" | "thread"): boolean {
    switch (this.config.mode) {
      case "off":
        return false;
      case "all":
        return true;
      case "non-main":
        return scope === "group" || scope === "thread";
      default:
        return false;
    }
  }

  /**
   * Executes a command inside a sandboxed Docker container.
   *
   * The container is lazily created if it does not already exist for the given
   * scope key. Returns a `SandboxResult` with stdout, stderr, and exit code.
   * Non-zero exit codes do NOT throw — only Docker infrastructure failures do.
   */
  async execute(
    command: string,
    options?: SandboxExecuteOptions,
  ): Promise<SandboxResult> {
    const sessionId = options?.sessionId ?? "default";
    const timeoutMs = options?.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;

    const containerId = await this.getContainer(sessionId);

    const args = ["exec"];

    // Env vars
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("--env", `${key}=${value}`);
      }
    }

    // Working directory
    if (options?.cwd) {
      args.push("--workdir", options.cwd);
    }

    // Security: Sanitize env var keys/values to prevent injection via --env
    if (options?.env) {
      for (const [key] of Object.entries(options.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
      }
    }

    // Note: command is passed as a single argument to `sh -c` inside the container.
    // While execFile prevents host-level shell injection, `sh -c` re-enables shell
    // interpretation inside the container. This is by design — the sandbox provides
    // isolation via Docker's security boundary (resource limits, no-network, etc.).
    args.push(containerId, "sh", "-c", command);

    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        timeout: timeoutMs,
        maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      });

      return { stdout, stderr, exitCode: 0, truncated: false };
    } catch (err: unknown) {
      // Non-zero exit codes come through as errors with `code` property
      if (isExecError(err)) {
        const truncated = isTruncationError(err);
        return {
          stdout: truncateOutput(err.stdout ?? ""),
          stderr: truncateOutput(err.stderr ?? ""),
          exitCode: typeof err.code === "number" ? err.code : 1,
          truncated,
        };
      }
      throw new SandboxExecutionError(command, err);
    }
  }

  /**
   * Destroys a container for the given session ID. Idempotent — does not
   * throw if the container does not exist.
   */
  async destroyContainer(sessionId: string): Promise<void> {
    const key = this.scopeKey(sessionId);
    const pending = this.containers.get(key);
    if (!pending) return;

    this.containers.delete(key);
    try {
      const containerId = await pending;
      await execFileAsync("docker", ["rm", "-f", containerId], {
        timeout: this.dockerTimeoutMs,
      });
      this.logger.debug(`Destroyed sandbox container ${containerId}`);
    } catch (err) {
      this.logger.warn(
        `Failed to destroy sandbox container for ${key}: ${err}`,
      );
    }
  }

  /** Destroys all tracked containers. Best-effort — errors are logged. */
  async destroyAll(): Promise<void> {
    const keys = Array.from(this.containers.keys());
    // Collect all session IDs before iterating to avoid mutation during loop
    const destroys = keys.map((key) => {
      // Extract sessionId from scope key — reverse the scopeKey derivation
      const pending = this.containers.get(key);
      if (!pending) return Promise.resolve();

      this.containers.delete(key);
      return pending
        .then((containerId) =>
          execFileAsync("docker", ["rm", "-f", containerId], {
            timeout: this.dockerTimeoutMs,
          }),
        )
        .then(() => undefined)
        .catch((err) => {
          this.logger.warn(
            `Failed to destroy sandbox container for ${key}: ${err}`,
          );
        });
    });

    await Promise.all(destroys);
  }

  /** Returns a list of resolved container IDs for all currently tracked containers. */
  async listContainers(): Promise<string[]> {
    const entries = Array.from(this.containers.values());
    const results: string[] = [];
    for (const pending of entries) {
      try {
        results.push(await pending);
      } catch {
        // Skip failed container creations
      }
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Returns (or creates) the container for the given session.
   * The in-flight creation Promise is stored immediately to coalesce concurrent calls.
   */
  private getContainer(sessionId: string): Promise<string> {
    const key = this.scopeKey(sessionId);

    const existing = this.containers.get(key);
    if (existing) return existing;

    const creation = this.createContainer(key);
    this.containers.set(key, creation);

    // If creation fails, remove from the map so the next call retries
    creation.catch(() => {
      this.containers.delete(key);
    });

    return creation;
  }

  /** Derives the container name from the scope config and session/key. */
  private containerName(key: string): string {
    return `${CONTAINER_PREFIX}-${key}`;
  }

  /** Derives a scope key from the session ID based on the configured scope. */
  private scopeKey(sessionId: string): string {
    switch (this.config.scope) {
      case "shared":
        return "shared";
      case "agent":
        return `agent-${sessionId}`;
      case "session":
      default:
        return sessionId;
    }
  }

  /** Creates a new Docker container and returns its ID. */
  private async createContainer(key: string): Promise<string> {
    const name = this.containerName(key);
    const image = this.config.image ?? DEFAULT_IMAGE;
    const memory = this.config.maxMemory ?? DEFAULT_MAX_MEMORY;
    const cpu = this.config.maxCpu ?? DEFAULT_MAX_CPU;

    // Stale container recovery — remove any leftover container with the same name
    try {
      await execFileAsync("docker", ["rm", "-f", name], {
        timeout: this.dockerTimeoutMs,
      });
    } catch {
      // Container may not exist — that's fine
    }

    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--memory",
      memory,
      "--cpus",
      cpu,
      "--label",
      "managed-by=agenc",
    ];

    // Network isolation
    if (!this.config.networkAccess) {
      args.push("--network", "none");
    }

    // Workspace mount
    const access = this.config.workspaceAccess ?? "none";
    if (access !== "none" && this.workspacePath) {
      const mountMode = access === "readonly" ? "ro" : "rw";
      args.push("--volume", `${this.workspacePath}:/workspace:${mountMode}`);
    }

    args.push(image, "tail", "-f", "/dev/null");

    this.logger.debug(`Creating sandbox container: docker ${args.join(" ")}`);

    try {
      const { stdout } = await execFileAsync("docker", args, {
        timeout: this.dockerTimeoutMs,
      });
      const containerId = stdout.trim();

      // Run optional setup script
      if (this.config.setupScript) {
        this.logger.debug(`Running setup script in ${containerId}`);
        await execFileAsync(
          "docker",
          ["exec", containerId, "sh", "-c", this.config.setupScript],
          { timeout: this.dockerTimeoutMs },
        );
      }

      this.logger.info(`Sandbox container created: ${containerId} (${name})`);
      return containerId;
    } catch (err) {
      throw new SandboxUnavailableError(err);
    }
  }
}

// ============================================================================
// Internal utilities
// ============================================================================

interface ExecError {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  killed?: boolean;
  message?: string;
}

function isExecError(err: unknown): err is ExecError {
  return (
    err instanceof Error &&
    ("stdout" in err || "stderr" in err || "code" in err)
  );
}

function isTruncationError(err: ExecError): boolean {
  return (
    err.killed === true ||
    (typeof err.message === "string" && err.message.includes("maxBuffer"))
  );
}

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") > DEFAULT_MAX_OUTPUT_BYTES) {
    // Truncate to approximate byte limit
    const buf = Buffer.from(output, "utf8");
    return buf.subarray(0, DEFAULT_MAX_OUTPUT_BYTES).toString("utf8");
  }
  return output;
}
