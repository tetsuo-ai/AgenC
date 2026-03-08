/**
 * Client-side WebSocket protocol types for the AgenC WebChat UI.
 *
 * Uses the canonical backend schema from runtime/src/channels/webchat/protocol.ts
 * to avoid protocol drift.
 */

import type {
  SubagentLifecyclePayload,
  SubagentLifecycleType,
} from '../../runtime/src/channels/webchat/protocol.ts';
import type {
  BackgroundRunControlAction,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from '../../runtime/src/gateway/background-run-operator.ts';

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
  /** Subagent lifecycle and nested child execution associated with this message. */
  subagents?: SubagentTimelineItem[];
  /** File attachments on this message. */
  attachments?: ChatMessageAttachment[];
}

export interface ContextUsageSection {
  id: string;
  label: string;
  tokens: number;
  percent: number;
}

export interface TokenUsage {
  /** Cumulative tokens used this session. */
  totalTokens: number;
  /** Session token budget used for auto-compaction. */
  budget: number;
  /** Whether context was auto-compacted this round. */
  compacted?: boolean;
  /** Model context window for the active provider/model, when available. */
  contextWindowTokens?: number;
  /** Estimated prompt tokens for the latest request. */
  promptTokens?: number;
  /** Prompt token budget after output+safety reservations. */
  promptTokenBudget?: number;
  /** Max completion tokens reserved by provider config. */
  maxOutputTokens?: number;
  /** Safety margin reserved for protocol/provider overhead. */
  safetyMarginTokens?: number;
  /** Prompt composition breakdown by context section. */
  sections?: ContextUsageSection[];
}

export interface ToolCall {
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  status: 'executing' | 'completed';
  subagentSessionId?: string;
  traceId?: string;
  parentTraceId?: string;
}

export type SubagentTimelineStatus =
  | 'planned'
  | 'spawned'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'synthesized';

export interface SubagentTimelineEvent {
  type: SubagentLifecycleType;
  timestamp: number;
  toolName?: string;
  data?: Record<string, unknown>;
}

export interface SubagentTimelineItem {
  subagentSessionId: string;
  parentSessionId?: string;
  objective?: string;
  status: SubagentTimelineStatus;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  outputSummary?: string;
  errorReason?: string;
  tools: ToolCall[];
  events: SubagentTimelineEvent[];
  traceId?: string;
  parentTraceId?: string;
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
  backgroundRuns?: {
    multiAgentEnabled: boolean;
    activeTotal: number;
    queuedSignalsTotal: number;
    stateCounts: Record<
      | 'pending'
      | 'running'
      | 'working'
      | 'blocked'
      | 'paused'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'suspended',
      number
    >;
    recentAlerts: Array<{
      id: string;
      severity: 'info' | 'warn' | 'error';
      code: string;
      message: string;
      createdAt: number;
      sessionId?: string;
      runId?: string;
    }>;
    metrics: {
      startedTotal: number;
      completedTotal: number;
      failedTotal: number;
      blockedTotal: number;
      recoveredTotal: number;
      meanLatencyMs?: number;
      meanTimeToFirstAckMs?: number;
      meanTimeToFirstVerifiedUpdateMs?: number;
      falseCompletionRate?: number;
      blockedWithoutNoticeRate?: number;
      meanStopLatencyMs?: number;
      recoverySuccessRate?: number;
      verifierAccuracyRate?: number;
    };
  };
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
  message?: string;
  deadlineAt?: number;
  slaMs?: number;
  escalateAt?: number;
  escalatedAt?: number;
  allowDelegatedResolution?: boolean;
  approverGroup?: string;
  requiredApproverRoles?: readonly string[];
  escalateToSessionId?: string;
  escalated?: boolean;
  parentSessionId?: string;
  subagentSessionId?: string;
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
  endpoint?: string;
  metadataUri?: string;
  registeredAt?: number;
  lastActive?: number;
  totalEarned?: string;
  activeTasks?: number;
}

// ============================================================================
// Activity Feed
// ============================================================================

export interface ActivityEvent {
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
  traceId?: string;
  parentTraceId?: string;
}

// ============================================================================
// Durable Runs
// ============================================================================

export type RunSummary = BackgroundRunOperatorSummary;
export type RunDetail = BackgroundRunOperatorDetail;
export type RunControlAction = BackgroundRunControlAction;

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
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  isError?: boolean;
  // Events
  eventType?: string;
  data?: Record<string, unknown>;
  traceId?: string;
  parentTraceId?: string;
  // Approval
  requestId?: string;
  action?: string;
  details?: Record<string, unknown>;
  // Resume
  sessionId?: string;
  messageCount?: number;
  active?: boolean;
  filters?: string[];
  // Subagent lifecycle
  subagent?: SubagentLifecyclePayload;
}

// ============================================================================
// Voice
// Keep in sync with runtime/src/channels/webchat/types.ts voice protocol types
// ============================================================================

export type VoiceState = 'inactive' | 'connecting' | 'listening' | 'speaking' | 'processing' | 'delegating';

export type VoiceMode = 'vad' | 'push-to-talk';

// ============================================================================
// Navigation
// ============================================================================

export type ViewId = 'chat' | 'status' | 'runs' | 'skills' | 'tasks' | 'memory' | 'activity' | 'desktop' | 'settings' | 'payment';
