/**
 * DesktopSandboxManager — manages Docker containers running isolated Linux
 * desktop environments. Each container runs XFCE + Xvfb + noVNC + a REST API
 * exposing computer-use tools.
 *
 * Uses execFile("docker", ...) for all Docker operations — same pattern as
 * the existing SandboxManager in gateway/sandbox.ts. No new dependencies.
 */

import { execFile } from "node:child_process";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import {
  DesktopSandboxLifecycleError,
  DesktopSandboxPoolExhaustedError,
} from "./errors.js";
import {
  defaultDesktopSandboxConfig,
  type CreateDesktopSandboxOptions,
  type DesktopSandboxConfig,
  type DesktopSandboxHandle,
  type DesktopSandboxInfo,
  type DesktopSandboxStatus,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const CONTAINER_PREFIX = "agenc-desktop";
const MANAGED_BY_LABEL = "managed-by=agenc-desktop";
const DOCKER_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 1_000;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_TIMEOUT_MS = 3_000;

/** Container-internal port for the REST API. */
const CONTAINER_API_PORT = 9990;
/** Container-internal port for noVNC. */
const CONTAINER_VNC_PORT = 6080;
/** Max subprocess output buffer (1 MB). */
const MAX_EXEC_BUFFER = 1024 * 1024;
/** Max PIDs per container — limits fork bombs. */
const CONTAINER_PID_LIMIT = "256";

// ============================================================================
// Internal utilities
// ============================================================================

function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs = DOCKER_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_EXEC_BUFFER },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Status values that indicate a container is still operational. */
function isActiveStatus(status: DesktopSandboxStatus): boolean {
  return status !== "stopped" && status !== "failed";
}

interface PortMapping {
  apiHostPort: number;
  vncHostPort: number;
}

function parsePortMappings(inspectJson: string): PortMapping {
  // docker inspect --format '{{json .NetworkSettings.Ports}}'
  // Returns: {"6080/tcp":[{"HostIp":"0.0.0.0","HostPort":"32768"}],"9990/tcp":[...]}
  let ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  try {
    ports = JSON.parse(inspectJson) as typeof ports;
  } catch (err) {
    throw new Error(`Invalid port mapping JSON: ${toErrorMessage(err)}`);
  }

  const apiKey = `${CONTAINER_API_PORT}/tcp`;
  const vncKey = `${CONTAINER_VNC_PORT}/tcp`;
  const apiBindings = ports[apiKey];
  const vncBindings = ports[vncKey];

  if (!apiBindings?.[0]?.HostPort) {
    throw new Error(`No host port mapping found for REST API (${apiKey})`);
  }
  if (!vncBindings?.[0]?.HostPort) {
    throw new Error(`No host port mapping found for noVNC (${vncKey})`);
  }

  return {
    apiHostPort: parseInt(apiBindings[0].HostPort, 10),
    vncHostPort: parseInt(vncBindings[0].HostPort, 10),
  };
}

// ============================================================================
// Manager
// ============================================================================

export interface DesktopSandboxManagerOptions {
  logger?: Logger;
}

export class DesktopSandboxManager {
  private readonly config: Required<
    Omit<DesktopSandboxConfig, "labels">
  > & { labels?: Record<string, string> };
  private readonly logger: Logger;

  /** containerId → handle */
  private readonly handles = new Map<string, DesktopSandboxHandle>();
  /** sessionId → containerId */
  private readonly sessionMap = new Map<string, string>();
  /** containerId → idle timeout handle */
  private readonly idleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** containerId → lifetime timeout handle */
  private readonly lifetimeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Cached Docker availability check */
  private dockerAvailable: boolean | null = null;

  constructor(
    config: DesktopSandboxConfig,
    options?: DesktopSandboxManagerOptions,
  ) {
    const defaults = defaultDesktopSandboxConfig();
    this.config = {
      enabled: config.enabled,
      image: config.image ?? defaults.image!,
      resolution: config.resolution ?? defaults.resolution!,
      maxMemory: config.maxMemory ?? defaults.maxMemory!,
      maxCpu: config.maxCpu ?? defaults.maxCpu!,
      maxConcurrent: config.maxConcurrent ?? defaults.maxConcurrent!,
      idleTimeoutMs: config.idleTimeoutMs ?? defaults.idleTimeoutMs!,
      maxLifetimeMs: config.maxLifetimeMs ?? defaults.maxLifetimeMs!,
      healthCheckIntervalMs:
        config.healthCheckIntervalMs ?? defaults.healthCheckIntervalMs!,
      networkMode: config.networkMode ?? defaults.networkMode!,
      securityProfile: config.securityProfile ?? defaults.securityProfile!,
      labels: config.labels,
      playwright: config.playwright ?? {},
    };
    this.logger = options?.logger ?? silentLogger;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Check if Docker daemon is reachable. Result is cached. */
  async isAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      await execFileAsync("docker", ["info"], 5_000);
      this.dockerAvailable = true;
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  /** Start the manager: check Docker, clean up orphan containers. */
  async start(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      this.logger.warn("Docker not available — desktop sandbox disabled");
      return;
    }
    await this.cleanupOrphans();
    this.logger.info("Desktop sandbox manager started");
  }

  /** Stop the manager: destroy all containers, clear all timers. */
  async stop(): Promise<void> {
    await this.destroyAll();
    this.logger.info("Desktop sandbox manager stopped");
  }

  /** Number of active (non-stopped/failed) containers. */
  get activeCount(): number {
    let count = 0;
    for (const h of this.handles.values()) {
      if (isActiveStatus(h.status)) count++;
    }
    return count;
  }

  /** Create a new desktop container for a session. */
  async create(
    options: CreateDesktopSandboxOptions,
  ): Promise<DesktopSandboxHandle> {
    if (this.activeCount >= this.config.maxConcurrent) {
      throw new DesktopSandboxPoolExhaustedError(this.config.maxConcurrent);
    }

    const { sessionId } = options;
    const containerName = `${CONTAINER_PREFIX}-${sanitizeSessionId(sessionId)}`;
    const resolution = options.resolution ?? this.config.resolution;
    const image = options.image ?? this.config.image;

    // Remove any stale container with the same name
    await this.forceRemove(containerName);

    const args = this.buildDockerRunArgs(
      containerName,
      resolution,
      image,
      sessionId,
      options,
    );

    this.logger.info(
      `Creating desktop sandbox for session ${sessionId} (${resolution.width}x${resolution.height})`,
    );

    const containerId = await this.runContainer(args);
    const ports = await this.inspectPorts(containerId);

    const handle: DesktopSandboxHandle = {
      containerId,
      containerName,
      sessionId,
      status: "starting",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      apiHostPort: ports.apiHostPort,
      vncHostPort: ports.vncHostPort,
      resolution,
    };

    this.handles.set(containerId, handle);
    this.sessionMap.set(sessionId, containerId);

    // Wait for the REST server to become ready
    try {
      await this.waitForReady(handle);
      handle.status = "ready";
    } catch (err) {
      handle.status = "failed";
      this.logger.error(
        `Desktop sandbox ${containerId} failed to become ready: ${toErrorMessage(err)}`,
      );
      // Don't throw — the handle is tracked, caller can check status
    }

    // Start idle and lifetime timers
    this.resetIdleTimer(containerId);
    this.startLifetimeTimer(containerId);

    this.logger.info(
      `Desktop sandbox ${containerId} is ${handle.status} (API: ${ports.apiHostPort}, VNC: ${ports.vncHostPort})`,
    );

    return handle;
  }

  /** Get existing sandbox for session, or create one. */
  async getOrCreate(sessionId: string): Promise<DesktopSandboxHandle> {
    const existing = this.getHandleBySession(sessionId);
    if (existing && isActiveStatus(existing.status)) {
      return existing;
    }
    // Clean up failed/stopped handle if present
    if (existing) {
      this.handles.delete(existing.containerId);
      this.sessionMap.delete(sessionId);
    }
    return this.create({ sessionId });
  }

  /** Destroy a container by ID. Idempotent. */
  async destroy(containerId: string): Promise<void> {
    const handle = this.handles.get(containerId);

    // Clear timers
    this.clearTimers(containerId);

    if (handle) {
      handle.status = "stopping";
      this.sessionMap.delete(handle.sessionId);
    }

    await this.forceRemove(containerId);

    if (handle) {
      handle.status = "stopped";
    }
    this.handles.delete(containerId);
  }

  /** Destroy the container assigned to a session. Idempotent. */
  async destroyBySession(sessionId: string): Promise<void> {
    const containerId = this.sessionMap.get(sessionId);
    if (containerId) {
      await this.destroy(containerId);
    }
  }

  /** Destroy all tracked containers. Best-effort. */
  async destroyAll(): Promise<void> {
    const ids = [...this.handles.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }

  /** Get handle by container ID. */
  getHandle(containerId: string): DesktopSandboxHandle | undefined {
    return this.handles.get(containerId);
  }

  /** Get handle by session ID. */
  getHandleBySession(sessionId: string): DesktopSandboxHandle | undefined {
    const containerId = this.sessionMap.get(sessionId);
    return containerId ? this.handles.get(containerId) : undefined;
  }

  /** Return all sandbox info objects. */
  listAll(): DesktopSandboxInfo[] {
    const now = Date.now();
    return [...this.handles.values()].map((h) => ({
      containerId: h.containerId,
      sessionId: h.sessionId,
      status: h.status,
      createdAt: h.createdAt,
      lastActivityAt: h.lastActivityAt,
      vncUrl: `http://localhost:${h.vncHostPort}/vnc.html`,
      uptimeMs: now - h.createdAt,
    }));
  }

  /** Reset idle timer (called on tool use). */
  touchActivity(containerId: string): void {
    const handle = this.handles.get(containerId);
    if (handle) {
      handle.lastActivityAt = Date.now();
      this.resetIdleTimer(containerId);
    }
  }

  // --------------------------------------------------------------------------
  // Container creation helpers
  // --------------------------------------------------------------------------

  /** Build the `docker run` argument array. */
  private buildDockerRunArgs(
    containerName: string,
    resolution: { width: number; height: number },
    image: string,
    sessionId: string,
    options: CreateDesktopSandboxOptions,
  ): string[] {
    const args: string[] = [
      "run",
      "--detach",
      "--name",
      containerName,
      "--memory",
      this.config.maxMemory,
      "--cpus",
      this.config.maxCpu,
      "--pids-limit",
      CONTAINER_PID_LIMIT,
      "--memory-swap",
      this.config.maxMemory,
    ];

    if (this.config.securityProfile === "strict") {
      args.push(
        "--cap-drop", "ALL",
        "--cap-add", "CHOWN",
        "--cap-add", "SETUID",
        "--cap-add", "SETGID",
        "--cap-add", "DAC_OVERRIDE",
        "--cap-add", "KILL",
        "--cap-add", "NET_BIND_SERVICE",
      );
    }

    args.push(
      "--label", MANAGED_BY_LABEL,
      "--label", `session-id=${sessionId}`,
      "--publish", `0:${CONTAINER_API_PORT}`,
      "--publish", `0:${CONTAINER_VNC_PORT}`,
      "--network", this.config.networkMode === "none" ? "none" : "bridge",
      "--env", `DISPLAY_WIDTH=${resolution.width}`,
      "--env", `DISPLAY_HEIGHT=${resolution.height}`,
    );

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          args.push("--env", `${key}=${value}`);
        }
      }
    }

    const extraLabels = { ...this.config.labels, ...options.labels };
    for (const [key, value] of Object.entries(extraLabels)) {
      args.push("--label", `${key}=${value}`);
    }

    args.push(image);
    return args;
  }

  /** Execute `docker run` and return the truncated container ID. */
  private async runContainer(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("docker", args);
      return stdout.trim().slice(0, 12);
    } catch (err) {
      throw new DesktopSandboxLifecycleError(
        `Failed to create container: ${toErrorMessage(err)}`,
      );
    }
  }

  /** Inspect the container's assigned host ports. Cleans up on failure. */
  private async inspectPorts(containerId: string): Promise<PortMapping> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        containerId,
      ]);
      return parsePortMappings(stdout.trim());
    } catch (err) {
      await this.forceRemove(containerId);
      throw new DesktopSandboxLifecycleError(
        `Failed to read port mappings: ${toErrorMessage(err)}`,
        containerId,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Poll the container's REST health endpoint until 200 OK. */
  private async waitForReady(handle: DesktopSandboxHandle): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      try {
        const res = await fetch(
          `http://localhost:${handle.apiHostPort}/health`,
          { signal: AbortSignal.timeout(READY_POLL_TIMEOUT_MS) },
        );
        if (res.ok) return;
      } catch {
        // Intentional: container not ready yet, keep polling
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    throw new DesktopSandboxLifecycleError(
      `Container did not become ready within ${READY_TIMEOUT_MS}ms`,
      handle.containerId,
    );
  }

  /** Remove stale orphan containers with our management label. */
  private async cleanupOrphans(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `label=${MANAGED_BY_LABEL}`,
        "--format",
        "{{.ID}}",
      ]);
      const ids = stdout.trim().split("\n").filter(Boolean);
      for (const id of ids) {
        this.logger.info(`Cleaning up orphan desktop container ${id}`);
        await this.forceRemove(id);
      }
    } catch {
      // Intentional: Docker may not be available — logged by caller
    }
  }

  /** Force-remove a container by name or ID. Idempotent. */
  private async forceRemove(nameOrId: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", nameOrId]);
    } catch {
      // Intentional: container may not exist
    }
  }

  /** Clear idle + lifetime timers for a container. */
  private clearTimers(containerId: string): void {
    const idle = this.idleTimers.get(containerId);
    if (idle) {
      clearTimeout(idle);
      this.idleTimers.delete(containerId);
    }
    const lifetime = this.lifetimeTimers.get(containerId);
    if (lifetime) {
      clearTimeout(lifetime);
      this.lifetimeTimers.delete(containerId);
    }
  }

  /** Reset the idle timeout timer for a container. */
  private resetIdleTimer(containerId: string): void {
    const existing = this.idleTimers.get(containerId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.logger.info(
        `Desktop sandbox ${containerId} idle timeout — destroying`,
      );
      void this.destroy(containerId).catch((err) => {
        this.logger.error(
          `Failed to destroy idle container ${containerId}: ${toErrorMessage(err)}`,
        );
      });
    }, this.config.idleTimeoutMs);

    // Don't keep the process alive just for idle timers
    timer.unref();
    this.idleTimers.set(containerId, timer);
  }

  /** Start the max lifetime timer for a container. */
  private startLifetimeTimer(containerId: string): void {
    const timer = setTimeout(() => {
      this.logger.info(
        `Desktop sandbox ${containerId} max lifetime reached — destroying`,
      );
      void this.destroy(containerId).catch((err) => {
        this.logger.error(
          `Failed to destroy expired container ${containerId}: ${toErrorMessage(err)}`,
        );
      });
    }, this.config.maxLifetimeMs);

    timer.unref();
    this.lifetimeTimers.set(containerId, timer);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Sanitize sessionId for use as a Docker container name suffix. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
}
