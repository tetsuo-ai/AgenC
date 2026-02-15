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

// Media pipeline (Phase 1.12)
export type { MediaPipelineConfig, MediaProcessingResult, TranscriptionProvider, ImageDescriptionProvider, MediaLogger } from './media.js';
export { MediaPipeline, NoopTranscriptionProvider, NoopImageDescriptionProvider, defaultMediaPipelineConfig } from './media.js';
