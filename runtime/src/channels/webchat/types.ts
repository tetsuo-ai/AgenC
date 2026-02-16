/**
 * WebChat channel type definitions.
 *
 * Defines the configuration, dependency injection interface, and WebSocket
 * protocol message types for the WebChat channel plugin.
 *
 * @module
 */

import type { ControlMessage, ControlResponse } from '../../gateway/types.js';

// ============================================================================
// WebChatHandler Interface
// ============================================================================

/**
 * Delegate interface for routing dotted-namespace WebSocket messages
 * from the Gateway to the WebChat channel plugin.
 *
 * The Gateway's handleControlMessage default case delegates to this
 * handler for any message type containing a dot (e.g. 'chat.message').
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
// WebChatDeps (dependency injection)
// ============================================================================

/**
 * Dependencies injected into the WebChatChannel at construction time.
 */
export interface WebChatDeps {
  /** Gateway instance for status queries. */
  gateway: {
    getStatus(): { state: string; uptimeMs: number; channels: string[]; activeSessions: number; controlPlanePort: number };
    config: { agent?: { name?: string } };
  };
}

// ============================================================================
// WebChatChannelConfig
// ============================================================================

export interface WebChatChannelConfig {
  /** Whether the webchat channel is enabled. Default: true */
  enabled?: boolean;
}

// ============================================================================
// WebSocket Protocol — Client → Server
// ============================================================================

export interface ChatMessageRequest {
  type: 'chat.message';
  content: string;
  attachments?: Array<{ type: string; url?: string; mimeType: string }>;
  id?: string;
}

export interface ChatTypingRequest {
  type: 'chat.typing';
  active: boolean;
  id?: string;
}

export interface ChatHistoryRequest {
  type: 'chat.history';
  limit?: number;
  id?: string;
}

export interface ChatResumeRequest {
  type: 'chat.resume';
  sessionId: string;
  id?: string;
}

export interface StatusGetRequest {
  type: 'status.get';
  id?: string;
}

export interface SkillsListRequest {
  type: 'skills.list';
  id?: string;
}

export interface SkillsToggleRequest {
  type: 'skills.toggle';
  skillName: string;
  enabled: boolean;
  id?: string;
}

export interface TasksListRequest {
  type: 'tasks.list';
  filter?: { status?: string };
  id?: string;
}

export interface TasksCreateRequest {
  type: 'tasks.create';
  params: Record<string, unknown>;
  id?: string;
}

export interface TasksCancelRequest {
  type: 'tasks.cancel';
  taskId: string;
  id?: string;
}

export interface MemorySearchRequest {
  type: 'memory.search';
  query: string;
  id?: string;
}

export interface MemorySessionsRequest {
  type: 'memory.sessions';
  limit?: number;
  id?: string;
}

export interface ApprovalRespondRequest {
  type: 'approval.respond';
  requestId: string;
  approved: boolean;
  id?: string;
}

export interface EventsSubscribeRequest {
  type: 'events.subscribe';
  filters?: string[];
  id?: string;
}

export interface EventsUnsubscribeRequest {
  type: 'events.unsubscribe';
  id?: string;
}

// ============================================================================
// WebSocket Protocol — Server → Client
// ============================================================================

export interface ChatMessageResponse {
  type: 'chat.message';
  content: string;
  sender: 'agent';
  timestamp: number;
  id?: string;
}

export interface ChatTypingResponse {
  type: 'chat.typing';
  active: boolean;
}

export interface ChatHistoryResponse {
  type: 'chat.history';
  messages: Array<{
    content: string;
    sender: 'user' | 'agent';
    timestamp: number;
  }>;
  id?: string;
}

export interface ChatResumedResponse {
  type: 'chat.resumed';
  sessionId: string;
  messageCount: number;
  id?: string;
}

export interface ToolExecutingResponse {
  type: 'tools.executing';
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultResponse {
  type: 'tools.result';
  toolName: string;
  result: string;
  durationMs: number;
  isError?: boolean;
}

export interface StatusUpdateResponse {
  type: 'status.update';
  payload: {
    state: string;
    uptimeMs: number;
    channels: string[];
    activeSessions: number;
    controlPlanePort: number;
    agentName?: string;
  };
  id?: string;
}

export interface SkillsListResponse {
  type: 'skills.list';
  payload: Array<{
    name: string;
    description: string;
    enabled: boolean;
  }>;
  id?: string;
}

export interface TasksListResponse {
  type: 'tasks.list';
  payload: Array<{
    id: string;
    status: string;
    reward?: string;
    creator?: string;
    worker?: string;
  }>;
  id?: string;
}

export interface MemoryResultsResponse {
  type: 'memory.results';
  payload: Array<{
    content: string;
    timestamp: number;
    role: string;
  }>;
  id?: string;
}

export interface MemorySessionsResponse {
  type: 'memory.sessions';
  payload: Array<{
    id: string;
    messageCount: number;
    lastActiveAt: number;
  }>;
  id?: string;
}

export interface ApprovalRequestResponse {
  type: 'approval.request';
  requestId: string;
  action: string;
  details: Record<string, unknown>;
}

export interface EventsEventResponse {
  type: 'events.event';
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface ErrorResponse {
  type: 'error';
  error: string;
  id?: string;
}
