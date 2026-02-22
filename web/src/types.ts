/**
 * Client-side WebSocket protocol types for the AgenC WebChat UI.
 *
 * These mirror the backend types in runtime/src/channels/webchat/types.ts
 * but are intentionally duplicated for browser isolation (no Node.js imports).
 */

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'reconnecting';

// ============================================================================
// Chat Messages
// ============================================================================

export interface ChatMessageAttachment {
  filename: string;
  mimeType: string;
  /** Base64 data URL for display (images). */
  dataUrl?: string;
}

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: number;
  /** Tool calls associated with this message. */
  toolCalls?: ToolCall[];
  /** File attachments on this message. */
  attachments?: ChatMessageAttachment[];
}

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  status: 'executing' | 'completed';
}

// ============================================================================
// Gateway Status
// ============================================================================

export interface GatewayStatus {
  state: string;
  uptimeMs: number;
  channels: string[];
  activeSessions: number;
  controlPlanePort: number;
  agentName?: string;
}

// ============================================================================
// Skills
// ============================================================================

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
}

// ============================================================================
// Tasks
// ============================================================================

export interface TaskInfo {
  id: string;
  status: string;
  reward?: string;
  creator?: string;
  worker?: string;
  description?: string;
}

// ============================================================================
// Memory
// ============================================================================

export interface MemoryEntry {
  content: string;
  timestamp: number;
  role: string;
}

export interface SessionInfo {
  id: string;
  messageCount: number;
  lastActiveAt: number;
}

// ============================================================================
// Approvals
// ============================================================================

export interface ApprovalRequest {
  requestId: string;
  action: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Agents
// ============================================================================

export interface AgentInfo {
  pda: string;
  agentId: string;
  authority: string;
  capabilities: string[];
  status: string;
  reputation: number;
  tasksCompleted: number;
  stake: string;
}

// ============================================================================
// Activity Feed
// ============================================================================

export interface ActivityEvent {
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// WebSocket Message Envelope
// ============================================================================

export interface WSMessage {
  type: string;
  payload?: unknown;
  id?: string;
  error?: string;
  // Chat-specific fields (sent flat, not in payload, for convenience)
  content?: string;
  sender?: 'agent';
  timestamp?: number;
  // Tool fields
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  // Events
  eventType?: string;
  data?: Record<string, unknown>;
  // Approval
  requestId?: string;
  action?: string;
  details?: Record<string, unknown>;
  // Resume
  sessionId?: string;
  messageCount?: number;
  active?: boolean;
}

// ============================================================================
// Voice
// Keep in sync with runtime/src/channels/webchat/types.ts voice protocol types
// ============================================================================

export type VoiceState = 'inactive' | 'connecting' | 'listening' | 'speaking' | 'processing';

export type VoiceMode = 'vad' | 'push-to-talk';

// ============================================================================
// Navigation
// ============================================================================

export type ViewId = 'chat' | 'status' | 'skills' | 'tasks' | 'memory' | 'activity' | 'desktop' | 'settings' | 'payment';
