/**
 * Desktop sandbox types for running isolated Linux desktop environments.
 *
 * Each sandbox is a Docker container running XFCE + Xvfb + noVNC + a REST API
 * exposing computer-use tools (screenshot, mouse, keyboard, bash, clipboard).
 */

// ============================================================================
// Sandbox status lifecycle
// ============================================================================

/**
 * Status lifecycle:
 * creating → starting → ready → unhealthy → stopping → stopped
 *                                    ↑           ↓
 *                                    └───────────┘ (restart attempt)
 * Any state may transition to "failed" on unrecoverable error.
 */
export type DesktopSandboxStatus =
  | "creating"
  | "starting"
  | "ready"
  | "unhealthy"
  | "stopping"
  | "stopped"
  | "failed";

// ============================================================================
// Display resolution
// ============================================================================

export interface DisplayResolution {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_RESOLUTION: DisplayResolution = {
  width: 1280,
  height: 1024,
};

// ============================================================================
// Configuration
// ============================================================================

export interface DesktopSandboxConfig {
  readonly enabled: boolean;
  /** Docker image name. Default: 'agenc/desktop:latest' */
  readonly image?: string;
  /** Virtual display resolution. Default: 1024x768 */
  readonly resolution?: DisplayResolution;
  /** Container memory limit. Default: '4g' */
  readonly maxMemory?: string;
  /** Container CPU limit. Default: '2.0' */
  readonly maxCpu?: string;
  /** Maximum concurrent desktop containers. Default: 4 */
  readonly maxConcurrent?: number;
  /** Idle timeout before container destruction (ms). Default: 1,800,000 (30 min) */
  readonly idleTimeoutMs?: number;
  /** Maximum container lifetime (ms). Default: 14,400,000 (4 hours) */
  readonly maxLifetimeMs?: number;
  /** Health check interval (ms). Default: 30,000 */
  readonly healthCheckIntervalMs?: number;
  /** Container network mode. Default: 'bridge' */
  readonly networkMode?: "none" | "bridge";
  /** Security profile. Default: 'strict' */
  readonly securityProfile?: "strict" | "permissive";
  /** Extra Docker labels. */
  readonly labels?: Record<string, string>;
  /** Auto-capture screenshot after GUI action tools (mouse, keyboard). Default: false */
  readonly autoScreenshot?: boolean;
  /** Playwright MCP browser automation options. */
  readonly playwright?: {
    /** Enable Playwright MCP bridge for structured browser automation. Default: true */
    readonly enabled?: boolean;
  };
}

export function defaultDesktopSandboxConfig(): DesktopSandboxConfig {
  return {
    enabled: false,
    image: "agenc/desktop:latest",
    resolution: DEFAULT_RESOLUTION,
    maxMemory: "4g",
    maxCpu: "2.0",
    maxConcurrent: 4,
    idleTimeoutMs: 1_800_000,
    maxLifetimeMs: 14_400_000,
    healthCheckIntervalMs: 30_000,
    networkMode: "bridge",
    securityProfile: "strict",
  };
}

// ============================================================================
// Sandbox handle (internal tracking state)
// ============================================================================

export interface DesktopSandboxHandle {
  readonly containerId: string;
  readonly containerName: string;
  readonly sessionId: string;
  status: DesktopSandboxStatus;
  readonly createdAt: number;
  lastActivityAt: number;
  /** Assigned host port for REST API (mapped from container port 9990) */
  readonly apiHostPort: number;
  /** Assigned host port for noVNC (mapped from container port 6080) */
  readonly vncHostPort: number;
  readonly resolution: DisplayResolution;
}

// ============================================================================
// Public info (returned by listAll)
// ============================================================================

export interface DesktopSandboxInfo {
  readonly containerId: string;
  readonly sessionId: string;
  readonly status: DesktopSandboxStatus;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly vncUrl: string;
  readonly uptimeMs: number;
}

// ============================================================================
// Create options
// ============================================================================

export interface CreateDesktopSandboxOptions {
  readonly sessionId: string;
  readonly resolution?: DisplayResolution;
  readonly image?: string;
  readonly env?: Record<string, string>;
  readonly labels?: Record<string, string>;
}
