export type {
  GatewayConfig,
  GatewayLLMConfig,
  GatewayMemoryConfig,
  GatewayChannelConfig,
  GatewayAgentConfig,
  GatewayConnectionConfig,
  GatewayLoggingConfig,
  GatewayBindConfig,
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
} from './types.js';

export {
  GatewayValidationError,
  GatewayConnectionError,
  GatewayStateError,
  GatewayLifecycleError,
  WorkspaceValidationError,
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

// Heartbeat scheduler (Phase 2.1)
export type {
  HeartbeatConfig,
  HeartbeatAction,
  HeartbeatContext,
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
