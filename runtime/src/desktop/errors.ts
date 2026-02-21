import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Container lifecycle operation failed (create, start, stop, destroy).
 */
export class DesktopSandboxLifecycleError extends RuntimeError {
  public readonly containerId: string | undefined;

  constructor(message: string, containerId?: string) {
    super(
      containerId
        ? `Desktop sandbox lifecycle error [${containerId}]: ${message}`
        : `Desktop sandbox lifecycle error: ${message}`,
      RuntimeErrorCodes.DESKTOP_SANDBOX_LIFECYCLE_ERROR,
    );
    this.name = "DesktopSandboxLifecycleError";
    this.containerId = containerId;
  }
}

/**
 * Container health check failed repeatedly.
 */
export class DesktopSandboxHealthError extends RuntimeError {
  public readonly containerId: string;

  constructor(containerId: string, message?: string) {
    super(
      `Desktop sandbox unhealthy [${containerId}]: ${message ?? "health check failed"}`,
      RuntimeErrorCodes.DESKTOP_SANDBOX_HEALTH_ERROR,
    );
    this.name = "DesktopSandboxHealthError";
    this.containerId = containerId;
  }
}

/**
 * REST API connection to sandbox container failed.
 */
export class DesktopSandboxConnectionError extends RuntimeError {
  public readonly containerId: string;

  constructor(containerId: string, message?: string) {
    super(
      `Desktop sandbox connection failed [${containerId}]: ${message ?? "unreachable"}`,
      RuntimeErrorCodes.DESKTOP_SANDBOX_CONNECTION_ERROR,
    );
    this.name = "DesktopSandboxConnectionError";
    this.containerId = containerId;
  }
}

/**
 * Maximum concurrent sandbox limit reached.
 */
export class DesktopSandboxPoolExhaustedError extends RuntimeError {
  public readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    super(
      `Desktop sandbox pool exhausted: ${maxConcurrent} containers at max capacity`,
      RuntimeErrorCodes.DESKTOP_SANDBOX_POOL_EXHAUSTED,
    );
    this.name = "DesktopSandboxPoolExhaustedError";
    this.maxConcurrent = maxConcurrent;
  }
}
