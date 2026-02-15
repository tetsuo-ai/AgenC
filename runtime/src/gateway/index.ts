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
  diffGatewayConfig,
  ConfigWatcher,
  type ConfigReloadCallback,
  type ConfigErrorCallback,
} from './config-watcher.js';

export { Gateway, type GatewayOptions } from './gateway.js';

export {
  SessionManager,
  deriveSessionId,
  type SessionScope,
  type SessionResetMode,
  type CompactionStrategy,
  type SessionResetConfig,
  type SessionConfig,
  type Session,
  type SessionLookupParams,
  type CompactionResult,
  type SessionInfo,
  type SummarizeCallback,
} from './session.js';
