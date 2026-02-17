export type {
  GatewayConfig,
  GatewayLLMConfig,
  GatewayMemoryConfig,
  GatewayChannelConfig,
  GatewayAgentConfig,
  GatewayConnectionConfig,
  GatewayLoggingConfig,
  GatewayBindConfig,
  GatewayVoiceConfig,
  GatewayTelemetryConfig,
  GatewayState,
  GatewayStatus,
  GatewayEvent,
  GatewayEventHandler,
  GatewayEventSubscription,
  ControlMessage,
  ControlMessageType,
  ControlResponse,
  ChannelHandle,
  ConfigDiff,
  WebChatHandler,
} from './types.js';

export {
  GatewayValidationError,
  GatewayConnectionError,
  GatewayStateError,
  GatewayLifecycleError,
  WorkspaceValidationError,
  SubAgentSpawnError,
  SubAgentTimeoutError,
  SubAgentNotFoundError,
  GatewayAuthError,
} from './errors.js';

export {
  getDefaultConfigPath,
  loadGatewayConfig,
  validateGatewayConfig,
  isValidGatewayConfig,
  diffGatewayConfig,
  ConfigWatcher,
  type ConfigReloadCallback,
  type ConfigErrorCallback,
} from './config-watcher.js';

export { Gateway, type GatewayOptions } from './gateway.js';

// Remote access (Phase 11 — Issue #1102)
export { createToken, verifyToken } from './jwt.js';
export { RemoteGatewayClient } from './remote.js';
export type {
  GatewayAuthConfig,
  JWTPayload,
  RemoteGatewayConfig,
  RemoteGatewayState,
  RemoteGatewayEvents,
  RemoteChatMessage,
  OfflineQueueEntry,
  PushNotification,
} from './remote-types.js';

export type {
  GatewayMessage,
  OutboundMessage,
  MessageAttachment,
  MessageScope,
  CreateGatewayMessageParams,
} from './message.js';

export {
  createGatewayMessage,
  createOutboundMessage,
  validateGatewayMessage,
  validateOutboundMessage,
  validateAttachment,
} from './message.js';

// Workspace files (Phase 3.5)
export type { WorkspaceFiles, WorkspaceValidation, WorkspaceFileName, AssembleSystemPromptOptions } from './workspace-files.js';
export {
  WORKSPACE_FILES,
  WorkspaceLoader,
  getDefaultWorkspacePath,
  assembleSystemPrompt,
  generateTemplate,
  scaffoldWorkspace,
} from './workspace-files.js';

// Personality templates (Phase 5.6)
export type { PersonalityTemplate } from './personality.js';
export {
  loadPersonalityTemplate,
  listPersonalityTemplates,
  mergePersonality,
} from './personality.js';

// Session management (Phase 1.6)
export type {
  SessionScope,
  SessionResetMode,
  CompactionStrategy,
  SessionConfig,
  SessionResetConfig,
  Session,
  SessionLookupParams,
  CompactionResult,
  SessionInfo,
  Summarizer,
} from './session.js';

export { SessionManager, deriveSessionId } from './session.js';

// Agent workspace model (Phase 7.1)
export type { AgentWorkspace, ToolPolicy, WorkspaceTemplate, WorkspaceConfigJson } from './workspace.js';
export {
  WorkspaceManager,
  WORKSPACE_CONFIG_FILE,
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_ID_PATTERN,
  MEMORY_NAMESPACE_PREFIX,
} from './workspace.js';

// Routing rules (Phase 7.2)
export type { RoutingMatch, RoutingRule } from './routing.js';
export { MessageRouter, RoutingValidationError } from './routing.js';

// Session isolation (Phase 7.3)
export type { IsolatedSessionContext, SessionIsolationManagerConfig, AuthState } from './session-isolation.js';
export { SessionIsolationManager } from './session-isolation.js';

// Slash commands (Phase 1.5)
export {
  SlashCommandRegistry,
  createDefaultCommands,
  type SlashCommandDef,
  type SlashCommandContext,
  type SlashCommandHandler,
  type ParsedCommand,
  type SlashCommandRegistryConfig,
} from './commands.js';

// Daemon lifecycle (Phase 2.4)
export {
  DaemonManager,
  getDefaultPidPath,
  writePidFile,
  readPidFile,
  removePidFile,
  pidFileExists,
  isProcessAlive,
  checkStalePid,
  generateSystemdUnit,
  generateLaunchdPlist,
  type DaemonManagerConfig,
  type DaemonStatus,
  type PidFileInfo,
  type StalePidResult,
} from './daemon.js';

// Voice Bridge (xAI Realtime)
export { VoiceBridge, type VoiceBridgeConfig } from './voice-bridge.js';

// Media pipeline (Phase 1.12)
export type { MediaPipelineConfig, MediaProcessingResult, TranscriptionProvider, ImageDescriptionProvider, MediaLogger } from './media.js';
export {
  MediaPipeline,
  NoopTranscriptionProvider,
  NoopImageDescriptionProvider,
  defaultMediaPipelineConfig,
  isAudioMime,
  isImageMime,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_TEMP_DIR,
  DEFAULT_TEMP_FILE_TTL_MS,
  DEFAULT_PROCESSING_TIMEOUT_MS,
} from './media.js';

// Lifecycle hooks (Phase 1.7)
export {
  HookDispatcher,
  createBuiltinHooks,
  type HookDispatcherConfig,
  type HookConfig,
  type HookEvent,
  type HookHandler,
  type HookContext,
  type HookResult,
  type DispatchResult,
} from './hooks.js';

// Cron scheduling (Phase 2.3)
export {
  parseCron,
  cronMatches,
  nextCronMatch,
  CronScheduler,
  type CronSchedule,
  type CronSchedulerConfig,
  type ScheduledJob,
  type HeartbeatActionDef,
  type HeartbeatContext,
} from './scheduler.js';

// Approval policies (Phase 5)
export type {
  ApprovalPolicyConfig,
  ApprovalRule,
  ApprovalConditions,
  ElevatedModeConfig,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalDisposition,
  ApprovalEngineConfig,
  ApprovalResponseHandler,
} from './approvals.js';

export {
  ApprovalEngine,
  DEFAULT_APPROVAL_RULES,
  createApprovalGateHook,
  globMatch,
  extractAmount,
} from './approvals.js';

// Channel plugin (Phase 1.5)
export {
  PluginCatalog,
  WebhookRouter,
  BaseChannelPlugin,
  ChannelNameInvalidError,
  ChannelAlreadyRegisteredError,
  ChannelNotFoundError,
  type ChannelPlugin,
  type ChannelContext,
  type PluginCatalogConfig,
  type WebhookRoute,
  type WebhookMethod,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookHandler,
  type ReactionEvent,
} from './channel.js';

// Cross-channel identity linking (Phase 1.9)
export type {
  IdentityAccount,
  IdentityLink,
  PendingLink,
  IdentityResolverConfig,
  IdentityStore,
} from './identity.js';

export {
  IdentityResolver,
  InMemoryIdentityStore,
  IdentityLinkExpiredError,
  IdentityLinkNotFoundError,
  IdentitySelfLinkError,
  IdentitySignatureError,
  IdentityValidationError,
} from './identity.js';

// Heartbeat scheduler (Phase 2.1)
export type {
  HeartbeatConfig,
  HeartbeatAction,
  HeartbeatResult,
  HeartbeatRunSummary,
  HeartbeatSchedulerOptions,
} from './heartbeat.js';

export {
  HeartbeatScheduler,
  HeartbeatStateError,
  HeartbeatActionError,
  HeartbeatTimeoutError,
  defaultHeartbeatConfig,
} from './heartbeat.js';

// Heartbeat actions (Phase 2.2)
export {
  createTaskScanAction,
  createSummaryAction,
  createPortfolioAction,
  createPollingAction,
  createDefaultHeartbeatActions,
  type TaskScanActionConfig,
  type SummaryActionConfig,
  type PortfolioActionConfig,
  type PollingActionConfig,
  type DefaultHeartbeatActionsConfig,
} from './heartbeat-actions.js';

// Execution sandboxing (Phase 4.5)
export type {
  SandboxConfig,
  SandboxResult,
  SandboxExecuteOptions,
  SandboxMode,
  SandboxScope,
  WorkspaceAccessMode,
} from './sandbox.js';

export {
  SandboxManager,
  SandboxExecutionError,
  SandboxUnavailableError,
  defaultSandboxConfig,
  checkDockerAvailable,
} from './sandbox.js';

// Sub-agent spawning (Phase 7.4)
export type {
  SubAgentConfig,
  SubAgentResult,
  SubAgentManagerConfig,
  SubAgentStatus,
  SubAgentInfo,
} from './sub-agent.js';

export {
  SubAgentManager,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  MAX_CONCURRENT_SUB_AGENTS,
  SUB_AGENT_SESSION_PREFIX,
} from './sub-agent.js';
