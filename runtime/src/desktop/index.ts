// Types
export type {
  DesktopSandboxStatus,
  DisplayResolution,
  DesktopSandboxConfig,
  DesktopSandboxHandle,
  DesktopSandboxInfo,
  CreateDesktopSandboxOptions,
} from "./types.js";
export { DEFAULT_RESOLUTION, defaultDesktopSandboxConfig } from "./types.js";

// Errors
export {
  DesktopSandboxLifecycleError,
  DesktopSandboxHealthError,
  DesktopSandboxConnectionError,
  DesktopSandboxPoolExhaustedError,
} from "./errors.js";

// Manager
export {
  DesktopSandboxManager,
  type DesktopSandboxManagerOptions,
} from "./manager.js";

// REST Bridge
export {
  DesktopRESTBridge,
  type DesktopRESTBridgeOptions,
} from "./rest-bridge.js";

// Session Router
export {
  createDesktopAwareToolHandler,
  getCachedDesktopToolDefinitions,
  destroySessionBridge,
  type DesktopRouterOptions,
} from "./session-router.js";

// Health Monitoring
export {
  DesktopSandboxWatchdog,
  type DesktopSandboxWatchdogConfig,
} from "./health.js";

// Tool Definitions (parameter schemas for LLM)
export {
  TOOL_DEFINITIONS as DESKTOP_TOOL_DEFINITIONS,
  type DesktopToolDefinition,
} from "./tool-definitions.js";
