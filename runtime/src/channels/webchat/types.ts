/**
 * WebChat channel type definitions.
 *
 * Defines the configuration, dependency injection interface, and WebSocket
 * protocol message types for the WebChat channel plugin.
 *
 * @module
 */

// Re-export the canonical WebChatHandler from gateway/types to avoid duplication
export type { WebChatHandler } from "../../gateway/types.js";
import type { GatewayStatus } from "../../gateway/types.js";
import type {
  BackgroundRunControlAction,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from "../../gateway/background-run-operator.js";

import type {
  ChatCancelledPayload,
  ChatSessionPayload,
  ChatSessionsPayload,
  EventsEventPayload,
  EventsSubscriptionPayload,
  SubagentLifecyclePayload,
  SubagentLifecycleType,
} from "./protocol.js";

// ============================================================================
// WebChatDeps (dependency injection)
// ============================================================================

/**
 * Dependencies injected into the WebChatChannel at construction time.
 */
export interface WebChatDeps {
  /** Gateway instance for status queries. */
  gateway: {
    getStatus(): GatewayStatus;
    config: {
      agent?: { name?: string };
      connection?: { rpcUrl?: string; keypairPath?: string };
    };
  };
  /** Optional skill listing for skills.list handler. */
  skills?: ReadonlyArray<{
    name: string;
    description: string;
    enabled: boolean;
  }>;
  /** Optional voice bridge for real-time voice sessions. */
  voiceBridge?: import("../../gateway/voice-bridge.js").VoiceBridge;
  /** Optional memory backend for memory.search / memory.sessions handlers. */
  memoryBackend?: import("../../memory/types.js").MemoryBackend;
  /** Optional approval engine for approval.respond handler. */
  approvalEngine?: import("../../gateway/approvals.js").ApprovalEngine;
  /** Optional callback to toggle a skill's enabled state. */
  skillToggle?: (name: string, enabled: boolean) => void;
  /** Optional Solana connection for on-chain task operations. */
  connection?: import("@solana/web3.js").Connection;
  /** Optional callback to broadcast events to all subscribed WS clients. */
  broadcastEvent?: (eventType: string, data: Record<string, unknown>) => void;
  /** Optional desktop sandbox manager for desktop.* handlers. */
  desktopManager?: import("../../desktop/manager.js").DesktopSandboxManager;
  /**
   * Optional callback fired before re-binding a web session to another desktop
   * container so per-session desktop bridges can be recycled safely.
   */
  onDesktopSessionRebound?: (sessionId: string) => void;
  /** Optional callback to fully reset backend context for a web session. */
  resetSessionContext?: (sessionId: string) => Promise<void> | void;
  /** Optional callback to rehydrate backend context for a resumed web session. */
  hydrateSessionContext?: (sessionId: string) => Promise<void> | void;
  /** Optional callback to cancel a daemon-owned background run for a session. */
  cancelBackgroundRun?: (sessionId: string) => Promise<boolean> | boolean;
  /** Optional listing helper for operator-facing durable background runs. */
  listBackgroundRuns?: (
    sessionIds: readonly string[],
  ) => Promise<readonly BackgroundRunOperatorSummary[]>;
  /** Optional detail helper for one durable background run. */
  inspectBackgroundRun?: (
    sessionId: string,
  ) => Promise<BackgroundRunOperatorDetail | undefined>;
  /** Optional mutation helper for operator-driven run controls. */
  controlBackgroundRun?: (
    params: {
      action: BackgroundRunControlAction;
      actor?: string;
      channel?: string;
    },
  ) => Promise<BackgroundRunOperatorDetail | undefined>;
  /** Optional policy simulation preview helper for operator workflows. */
  policyPreview?: (params: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }) => Promise<{
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{
        code: string;
        message: string;
      }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  }>;
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
  type: "chat.message";
  payload: {
    content: string;
    clientKey?: string;
    policyContext?: {
      tenantId?: string;
      projectId?: string;
    };
    attachments?: Array<{ type: string; url?: string; mimeType: string }>;
  };
  id?: string;
}

export interface ChatTypingRequest {
  type: "chat.typing";
  payload: { active: boolean };
  id?: string;
}

export interface ChatHistoryRequest {
  type: "chat.history";
  payload?: { limit?: number; clientKey?: string };
  id?: string;
}

export interface ChatResumeRequest {
  type: "chat.resume";
  payload: { sessionId: string; clientKey?: string };
  id?: string;
}

export interface ChatNewRequest {
  type: "chat.new";
  payload?: { clientKey?: string };
  id?: string;
}

export interface ChatSessionsRequest {
  type: "chat.sessions";
  payload?: { clientKey?: string };
  id?: string;
}

export interface ChatCancelRequest {
  type: "chat.cancel";
  payload?: { clientKey?: string };
  id?: string;
}

export interface StatusGetRequest {
  type: "status.get";
  id?: string;
}

export interface SkillsListRequest {
  type: "skills.list";
  id?: string;
}

export interface SkillsToggleRequest {
  type: "skills.toggle";
  payload: {
    skillName: string;
    enabled: boolean;
  };
  id?: string;
}

export interface TasksListRequest {
  type: "tasks.list";
  payload?: { filter?: { status?: string } };
  id?: string;
}

export interface TasksCreateRequest {
  type: "tasks.create";
  payload: { params: Record<string, unknown> };
  id?: string;
}

export interface TasksCancelRequest {
  type: "tasks.cancel";
  payload: { taskId: string };
  id?: string;
}

export interface MemorySearchRequest {
  type: "memory.search";
  payload: { query: string };
  id?: string;
}

export interface MemorySessionsRequest {
  type: "memory.sessions";
  payload?: { limit?: number };
  id?: string;
}

export interface ApprovalRespondRequest {
  type: "approval.respond";
  payload: {
    requestId: string;
    approved: boolean;
  };
  id?: string;
}

export interface PolicySimulateRequest {
  type: "policy.simulate";
  payload: {
    toolName: string;
    args?: Record<string, unknown>;
    sessionId?: string;
  };
  id?: string;
}

export interface EventsSubscribeRequest {
  type: "events.subscribe";
  payload?: { filters?: string[] };
  id?: string;
}

export interface EventsUnsubscribeRequest {
  type: "events.unsubscribe";
  id?: string;
}

export interface DesktopListRequest {
  type: "desktop.list";
  id?: string;
}

export interface DesktopCreateRequest {
  type: "desktop.create";
  payload?: {
    sessionId?: string;
    maxMemory?: string;
    maxCpu?: string;
  };
  id?: string;
}

export interface DesktopAttachRequest {
  type: "desktop.attach";
  payload: {
    containerId: string;
    sessionId?: string;
  };
  id?: string;
}

export interface DesktopDestroyRequest {
  type: "desktop.destroy";
  payload: { containerId: string };
  id?: string;
}

export interface RunsListRequest {
  type: "runs.list";
  payload?: { sessionId?: string };
  id?: string;
}

export interface RunInspectRequest {
  type: "run.inspect";
  payload?: { sessionId?: string };
  id?: string;
}

export interface RunControlRequest {
  type: "run.control";
  payload: BackgroundRunControlAction;
  id?: string;
}

// ============================================================================
// WebSocket Protocol — Server → Client
// ============================================================================

export interface ChatMessageResponse {
  type: "chat.message";
  payload: {
    content: string;
    sender: "agent";
    timestamp: number;
  };
  id?: string;
}

export interface ChatTypingResponse {
  type: "chat.typing";
  payload: { active: boolean };
  id?: string;
}

export interface ChatHistoryResponse {
  type: "chat.history";
  payload: Array<{
    content: string;
    sender: "user" | "agent";
    timestamp: number;
  }>;
  id?: string;
}

export interface ChatResumedResponse {
  type: "chat.resumed";
  payload: {
    sessionId: string;
    messageCount: number;
  };
  id?: string;
}

export interface ChatSessionResponse {
  type: "chat.session";
  payload: ChatSessionPayload;
  id?: string;
}

export interface ChatSessionsResponse {
  type: "chat.sessions";
  payload: ChatSessionsPayload;
  id?: string;
}

export interface ChatCancelledResponse {
  type: "chat.cancelled";
  payload: ChatCancelledPayload;
  id?: string;
}

export interface ToolExecutingResponse {
  type: "tools.executing";
  payload: {
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    subagentSessionId?: string;
  };
  id?: string;
}

export interface ToolResultResponse {
  type: "tools.result";
  payload: {
    toolName: string;
    toolCallId?: string;
    result: string;
    durationMs: number;
    isError?: boolean;
    subagentSessionId?: string;
  };
  id?: string;
}

export interface ChatStreamResponse {
  type: "chat.stream";
  payload: {
    content: string;
    done: boolean;
  };
  id?: string;
}

export interface AgentStatusResponse {
  type: "agent.status";
  payload: {
    phase:
      | "thinking"
      | "tool_call"
      | "generating"
      | "idle"
      | "background_run"
      | "background_wait";
    detail?: string;
  };
  id?: string;
}

export interface StatusUpdateResponse {
  type: "status.update";
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
  type: "skills.list";
  payload: Array<{
    name: string;
    description: string;
    enabled: boolean;
  }>;
  id?: string;
}

export interface TasksListResponse {
  type: "tasks.list";
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
  type: "memory.results";
  payload: Array<{
    content: string;
    timestamp: number;
    role: string;
  }>;
  id?: string;
}

export interface MemorySessionsResponse {
  type: "memory.sessions";
  payload: Array<{
    id: string;
    messageCount: number;
    lastActiveAt: number;
  }>;
  id?: string;
}

export interface ApprovalRequestResponse {
  type: "approval.request";
  payload: {
    requestId: string;
    action: string;
    details: Record<string, unknown>;
    message?: string;
    deadlineAt?: number;
    slaMs?: number;
    escalateAt?: number;
    allowDelegatedResolution?: boolean;
    approverGroup?: string;
    requiredApproverRoles?: readonly string[];
    parentSessionId?: string;
    subagentSessionId?: string;
  };
  id?: string;
}

export interface ApprovalEscalatedResponse {
  type: "approval.escalated";
  payload: {
    requestId: string;
    action: string;
    message?: string;
    escalatedAt: number;
    deadlineAt: number;
    escalateToSessionId: string;
    approverGroup?: string;
    requiredApproverRoles?: readonly string[];
    parentSessionId?: string;
    subagentSessionId?: string;
  };
  id?: string;
}

export interface PolicySimulateResponse {
  type: "policy.simulate";
  payload: {
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{
        code: string;
        message: string;
      }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  };
  id?: string;
}

export interface RunsListResponse {
  type: "runs.list";
  payload: readonly BackgroundRunOperatorSummary[];
  id?: string;
}

export interface RunInspectResponse {
  type: "run.inspect";
  payload: BackgroundRunOperatorDetail;
  id?: string;
}

export interface RunUpdatedResponse {
  type: "run.updated";
  payload: BackgroundRunOperatorDetail;
  id?: string;
}

export interface EventsEventResponse {
  type: "events.event";
  payload: EventsEventPayload;
  id?: string;
}

export interface EventsSubscribedResponse {
  type: "events.subscribed";
  payload: EventsSubscriptionPayload;
  id?: string;
}

export interface EventsUnsubscribedResponse {
  type: "events.unsubscribed";
  payload: EventsSubscriptionPayload;
  id?: string;
}

export interface SubagentLifecycleResponse {
  type: SubagentLifecycleType;
  payload: SubagentLifecyclePayload;
  id?: string;
}

export interface ErrorResponse {
  type: "error";
  error: string;
  id?: string;
}

// ============================================================================
// Voice WebSocket Protocol — Client → Server
// Keep in sync with web/src/types.ts voice types
// ============================================================================

export interface VoiceStartRequest {
  type: "voice.start";
  id?: string;
}

export interface VoiceAudioRequest {
  type: "voice.audio";
  payload: { audio: string }; // base64-encoded PCM
  id?: string;
}

export interface VoiceCommitRequest {
  type: "voice.commit";
  id?: string;
}

export interface VoiceStopRequest {
  type: "voice.stop";
  id?: string;
}
