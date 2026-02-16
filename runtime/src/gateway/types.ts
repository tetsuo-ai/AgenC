/**
 * Gateway type definitions.
 *
 * Defines configuration, state, events, and control plane message types
 * for the AgenC Gateway process.
 *
 * @module
 */

// ============================================================================
// Gateway Configuration
// ============================================================================

export interface GatewayLLMConfig {
  provider: 'grok' | 'anthropic' | 'ollama';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface GatewayMemoryConfig {
  backend: 'memory' | 'sqlite' | 'redis';
  dbPath?: string;
  url?: string;
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
  level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface GatewayBindConfig {
  port: number;
  bind?: string;
}

export interface GatewayConfig {
  gateway: GatewayBindConfig;
  agent: GatewayAgentConfig;
  connection: GatewayConnectionConfig;
  llm?: GatewayLLMConfig;
  memory?: GatewayMemoryConfig;
  channels?: Record<string, GatewayChannelConfig>;
  logging?: GatewayLoggingConfig;
  personality?: import('./personality/types.js').PersonalityConfig;
}

// ============================================================================
// Gateway State
// ============================================================================

export type GatewayState = 'stopped' | 'starting' | 'running' | 'stopping';

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
  | 'started'
  | 'stopped'
  | 'configReloaded'
  | 'configError'
  | 'channelConnected'
  | 'channelDisconnected'
  | 'error';

export type GatewayEventHandler = (...args: unknown[]) => void;

export interface GatewayEventSubscription {
  unsubscribe(): void;
}

// ============================================================================
// Control Plane Messages
// ============================================================================

export type ControlMessageType = 'ping' | 'status' | 'reload' | 'channels';

export interface ControlMessage {
  type: ControlMessageType;
  id?: string;
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
// Config Diff
// ============================================================================

export interface ConfigDiff {
  safe: string[];
  unsafe: string[];
}
