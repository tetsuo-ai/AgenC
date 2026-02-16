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
