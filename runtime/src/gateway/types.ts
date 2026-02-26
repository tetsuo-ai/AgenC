/**
 * Gateway type definitions.
 *
 * Defines configuration, state, events, and control plane message types
 * for the AgenC Gateway process.
 *
 * @module
 */

import type { GatewayAuthConfig } from "./remote-types.js";
import type { DesktopSandboxConfig } from "../desktop/types.js";

// ============================================================================
// Gateway Configuration
// ============================================================================

export interface GatewayLLMConfig {
  provider: "grok" | "ollama";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Maximum token budget per session. 0 or undefined = unlimited. */
  sessionTokenBudget?: number;
  /** Maximum tool call rounds per message. Default: 5. */
  maxToolRounds?: number;
  /** Additional LLM providers for fallback (tried in order after primary fails). */
  fallback?: GatewayLLMConfig[];
}

export interface GatewayMemoryConfig {
  backend: "memory" | "sqlite" | "redis";
  /** SQLite: database file path. Default: ~/.agenc/memory.db */
  dbPath?: string;
  /** Redis: connection URL (e.g. 'redis://localhost:6379') */
  url?: string;
  /** Redis: host. Default: 'localhost'. Ignored when url is set. */
  host?: string;
  /** Redis: port. Default: 6379. Ignored when url is set. */
  port?: number;
  /** Redis: password */
  password?: string;
  /** AES-256-GCM encryption key for content at rest (hex-encoded, 64 hex chars = 32 bytes). */
  encryptionKey?: string;
  /** Embedding provider for semantic memory. Auto-selects if omitted. */
  embeddingProvider?: "ollama" | "openai" | "noop";
  /** API key for embedding provider. Falls back to llm.apiKey. */
  embeddingApiKey?: string;
  /** Base URL for embedding provider (e.g. Ollama host). */
  embeddingBaseUrl?: string;
  /** Embedding model name (e.g. 'nomic-embed-text'). */
  embeddingModel?: string;
}

export interface GatewayChannelConfig {
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface GatewayAgentConfig {
  name: string;
  /** Capability bitmask as decimal string (bigint doesn't survive JSON round-trip) */
  capabilities?: string;
  endpoint?: string;
  stake?: string;
}

export interface GatewayConnectionConfig {
  rpcUrl: string;
  keypairPath?: string;
  endpoints?: string[];
}

export interface GatewayLoggingConfig {
  level?: "debug" | "info" | "warn" | "error";
}

export interface GatewayBindConfig {
  port: number;
  bind?: string;
}

export interface GatewayVoiceConfig {
  enabled?: boolean;
  voice?: "Ara" | "Rex" | "Sal" | "Eve" | "Leo";
  mode?: "vad" | "push-to-talk";
  /** Separate API key for voice. Falls back to llm.apiKey when not set. */
  apiKey?: string;
}

export interface GatewayTelemetryConfig {
  /** Enable metrics collection. Default: true. */
  enabled?: boolean;
  /** Auto-flush interval in ms. 0 = manual only. Default: 60000. */
  flushIntervalMs?: number;
}

export interface GatewayMCPConfig {
  /** External MCP servers to connect to via stdio transport */
  servers: GatewayMCPServerConfig[];
}

export interface GatewayMCPServerConfig {
  /** Human-readable server name (used for tool namespacing) */
  name: string;
  /** Executable command (e.g. "npx", "node") */
  command: string;
  /** Command arguments */
  args: string[];
  /** Optional environment variables for the child process */
  env?: Record<string, string>;
  /** Whether this server is enabled. Default: true */
  enabled?: boolean;
  /** Connection timeout in ms. Default: 30000 */
  timeout?: number;
  /** Route this server into a container instead of running on the host.
   *  Currently only "desktop" is supported — the MCP server will be spawned
   *  via `docker exec` inside the desktop sandbox container per session. */
  container?: "desktop";
}

export interface GatewayPolicyConfig {
  enabled?: boolean;
  toolAllowList?: string[];
  toolDenyList?: string[];
  actionBudgets?: Record<string, { limit: number; windowMs: number }>;
  /** Spend budget. `limitLamports` is a decimal string for JSON round-trip safety. */
  spendBudget?: { limitLamports: string; windowMs: number };
  /** Max risk score in [0, 1]. */
  maxRiskScore?: number;
  circuitBreaker?: {
    enabled?: boolean;
    threshold: number;
    windowMs: number;
    mode: "pause_discovery" | "halt_submissions" | "safe_mode";
  };
}

export interface GatewayMarketplaceConfig {
  enabled?: boolean;
  defaultMatchingPolicy?: "best_price" | "best_eta" | "weighted_score";
  antiSpam?: {
    maxActiveBidsPerBidderPerTask?: number;
    maxBidsPerTask?: number;
  };
  authorizedSelectorIds?: string[];
}

export interface GatewaySocialConfig {
  enabled?: boolean;
  discoveryEnabled?: boolean;
  discoveryCacheTtlMs?: number;
  discoveryCacheMaxEntries?: number;
  messagingEnabled?: boolean;
  messagingMode?: "on-chain" | "off-chain" | "auto";
  messagingPort?: number;
  feedEnabled?: boolean;
  collaborationEnabled?: boolean;
  reputationEnabled?: boolean;
}

export interface GatewayConfig {
  gateway: GatewayBindConfig;
  agent: GatewayAgentConfig;
  connection: GatewayConnectionConfig;
  llm?: GatewayLLMConfig;
  memory?: GatewayMemoryConfig;
  channels?: Record<string, GatewayChannelConfig>;
  logging?: GatewayLoggingConfig;
  auth?: GatewayAuthConfig;
  voice?: GatewayVoiceConfig;
  telemetry?: GatewayTelemetryConfig;
  desktop?: DesktopSandboxConfig;
  /** External MCP server connections */
  mcp?: GatewayMCPConfig;
  /** Policy engine: budget enforcement + circuit breakers on tool calls */
  policy?: GatewayPolicyConfig;
  /** Marketplace: task bidding between agents */
  marketplace?: GatewayMarketplaceConfig;
  /** Social module: discovery, messaging, feed, reputation, collaboration */
  social?: GatewaySocialConfig;
}

// ============================================================================
// Gateway State
// ============================================================================

export type GatewayState = "stopped" | "starting" | "running" | "stopping";

// ============================================================================
// Gateway Status Snapshot
// ============================================================================

export interface GatewayStatus {
  readonly state: GatewayState;
  readonly uptimeMs: number;
  readonly channels: string[];
  readonly activeSessions: number;
  readonly controlPlanePort: number;
}

// ============================================================================
// Gateway Events
// ============================================================================

export type GatewayEvent =
  | "started"
  | "stopped"
  | "configReloaded"
  | "configError"
  | "channelConnected"
  | "channelDisconnected"
  | "error";

export type GatewayEventHandler = (...args: unknown[]) => void;

export interface GatewayEventSubscription {
  unsubscribe(): void;
}

// ============================================================================
// Control Plane Messages
// ============================================================================

export type ControlMessageType =
  | "ping"
  | "status"
  | "reload"
  | "channels"
  | "sessions"
  | "sessions.kill"
  | "auth"
  | "config.get"
  | "config.set"
  | "wallet.info"
  | "wallet.airdrop"
  | "ollama.models";

export interface ControlMessage {
  type: ControlMessageType;
  id?: string;
  payload?: unknown;
}

export interface ControlResponse {
  type: string;
  payload?: unknown;
  id?: string;
  error?: string;
}

// ============================================================================
// Channel Handle
// ============================================================================

export interface ChannelHandle {
  readonly name: string;
  /** Live health check — implementations should report current status */
  isHealthy(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ============================================================================
// WebChat Handler
// ============================================================================

/**
 * Delegate interface for routing dotted-namespace WebSocket messages
 * from the Gateway to the WebChat channel plugin.
 */
export interface WebChatHandler {
  handleMessage(
    clientId: string,
    type: string,
    msg: ControlMessage,
    send: (response: ControlResponse) => void,
  ): void;
}

// ============================================================================
// Config Diff
// ============================================================================

export interface ConfigDiff {
  safe: string[];
  unsafe: string[];
}
