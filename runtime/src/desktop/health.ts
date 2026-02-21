/**
 * DesktopSandboxWatchdog — periodic health monitoring for desktop sandbox
 * containers. Detects unhealthy containers and attempts restart or marks
 * them as failed after exceeding the failure threshold.
 */

import { execFile } from "node:child_process";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { DesktopSandboxManager } from "./manager.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DOCKER_RESTART_TIMEOUT_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export interface DesktopSandboxWatchdogConfig {
  intervalMs?: number;
  unhealthyThreshold?: number;
  logger?: Logger;
}

// ============================================================================
// Watchdog
// ============================================================================

export class DesktopSandboxWatchdog {
  private readonly manager: DesktopSandboxManager;
  private readonly intervalMs: number;
  private readonly unhealthyThreshold: number;
  private readonly logger: Logger;

  /** containerId → consecutive failure count */
  private readonly failureCounts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    manager: DesktopSandboxManager,
    config?: DesktopSandboxWatchdogConfig,
  ) {
    this.manager = manager;
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.unhealthyThreshold = config?.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
    this.logger = config?.logger ?? silentLogger;
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.checkAll().catch((err) => {
        this.logger.error(`Watchdog check failed: ${toErrorMessage(err)}`);
      });
    }, this.intervalMs);

    // Don't keep the process alive for health checks
    this.timer.unref();
    this.logger.info("Desktop sandbox watchdog started");
  }

  /** Stop periodic health checks and clear state. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.failureCounts.clear();
    this.logger.info("Desktop sandbox watchdog stopped");
  }

  /** Run a single health check pass across all active containers. */
  async checkAll(): Promise<void> {
    const sandboxes = this.manager.listAll();
    for (const sandbox of sandboxes) {
      if (sandbox.status !== "ready" && sandbox.status !== "unhealthy") {
        continue;
      }

      const healthy = await this.isHealthy(sandbox.containerId);
      if (healthy) {
        // Reset failure counter on success
        this.failureCounts.delete(sandbox.containerId);
        const handle = this.manager.getHandle(sandbox.containerId);
        if (handle && handle.status === "unhealthy") {
          handle.status = "ready";
        }
        continue;
      }

      // Increment failure counter
      const count = (this.failureCounts.get(sandbox.containerId) ?? 0) + 1;
      this.failureCounts.set(sandbox.containerId, count);

      this.logger.warn(
        `Desktop sandbox ${sandbox.containerId} health check failed (${count}/${this.unhealthyThreshold})`,
      );

      const handle = this.manager.getHandle(sandbox.containerId);
      if (handle) {
        handle.status = "unhealthy";
      }

      if (count >= this.unhealthyThreshold) {
        this.logger.warn(
          `Desktop sandbox ${sandbox.containerId} exceeded failure threshold — attempting restart`,
        );
        const restarted = await this.restartContainer(sandbox.containerId);
        if (restarted) {
          this.failureCounts.delete(sandbox.containerId);
          if (handle) handle.status = "ready";
        } else {
          if (handle) handle.status = "failed";
          this.logger.error(
            `Desktop sandbox ${sandbox.containerId} restart failed — marked as failed`,
          );
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async isHealthy(containerId: string): Promise<boolean> {
    const handle = this.manager.getHandle(containerId);
    if (!handle) return false;

    try {
      const res = await fetch(
        `http://localhost:${handle.apiHostPort}/health`,
        { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private async restartContainer(containerId: string): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "docker",
          ["restart", containerId],
          { timeout: DOCKER_RESTART_TIMEOUT_MS },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return true;
    } catch (err) {
      this.logger.error(
        `Docker restart failed for ${containerId}: ${toErrorMessage(err)}`,
      );
      return false;
    }
  }
}
