/**
 * Mobile app types.
 *
 * Mirrors relevant types from the runtime for browser/RN isolation —
 * the mobile app does NOT import from @agenc/runtime.
 */

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting';

export interface GatewayConnection {
  url: string;
  token: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  timestamp: number;
}

export interface GatewayStatusInfo {
  state: string;
  uptimeMs: number;
  channels: string[];
  activeSessions: number;
}
