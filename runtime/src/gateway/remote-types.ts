/**
 * Type definitions for remote Gateway access and JWT authentication.
 *
 * Used by both the Gateway auth layer and the RemoteGatewayClient.
 *
 * @module
 */

// ============================================================================
// Authentication Configuration
// ============================================================================

export interface GatewayAuthConfig {
  /** HMAC-SHA256 shared secret (minimum 32 characters) */
  secret?: string;
  /** Token expiry in seconds (default: 3600 — 1 hour) */
  expirySeconds?: number;
  /** Allow unauthenticated access from localhost (default: true) */
  localBypass?: boolean;
}

export interface JWTPayload {
  /** Subject — typically an agent or user identifier */
  sub: string;
  /** Issued-at timestamp (Unix seconds) */
  iat: number;
  /** Expiry timestamp (Unix seconds) */
  exp: number;
  /** Access scope (reserved for future use) */
  scope?: string;
}

// ============================================================================
// Remote Client Configuration
// ============================================================================

export interface RemoteGatewayConfig {
  /** WebSocket URL of the Gateway control plane (e.g. wss://gateway.example.com) */
  url: string;
  /** JWT token for authentication */
  token: string;
  /** Ping keepalive interval in ms (default: 30000) */
  pingIntervalMs?: number;
  /** Enable automatic reconnection (default: true) */
  reconnect?: boolean;
  /** Base delay for exponential backoff in ms (default: 1000) */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  reconnectMaxDelayMs?: number;
  /** Maximum number of messages to queue while disconnected (default: 1000) */
  maxOfflineQueueSize?: number;
}

// ============================================================================
// Remote Client State & Events
// ============================================================================

export type RemoteGatewayState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting';

export interface RemoteGatewayEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  message: (data: unknown) => void;
  error: (error: Error) => void;
  authFailed: (reason: string) => void;
  stateChanged: (state: RemoteGatewayState) => void;
}

// ============================================================================
// Chat & Notification Types
// ============================================================================

export interface RemoteChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: number;
}

export interface OfflineQueueEntry {
  message: string;
  enqueuedAt: number;
}

export interface PushNotification {
  messageId: string;
  sender: string;
  preview: string;
  timestamp: number;
}
