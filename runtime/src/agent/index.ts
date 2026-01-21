/**
 * Agent types and utilities for @agenc/runtime
 * @packageDocumentation
 */

// Re-export capabilities module (canonical source for capability constants)
export {
  Capability,
  ALL_CAPABILITIES,
  ALL_CAPABILITY_NAMES,
  combineCapabilities,
  hasCapability,
  hasAllCapabilities,
  hasAnyCapability,
  getCapabilityNames,
  parseCapabilities,
  formatCapabilities,
  countCapabilities,
  type CapabilityName,
} from './capabilities.js';

export {
  // Constants
  AgentCapabilities,
  AGENT_REGISTRATION_SIZE,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  MAX_REPUTATION,
  MAX_U8,
  CAPABILITY_NAMES,

  // Enum
  AgentStatus,

  // Functions
  agentStatusToString,
  isValidAgentStatus,
  createCapabilityMask,
  parseAgentState,
  computeRateLimitState,

  // Types
  type AgentCapability,
  type AgentState,
  type AgentRegistrationParams,
  type AgentUpdateParams,
  type RateLimitState,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
} from './types.js';

// PDA derivation helpers
export {
  deriveAgentPda,
  deriveProtocolPda,
  findAgentPda,
  findProtocolPda,
  type PdaWithBump,
} from './pda.js';

// Event subscription utilities
export {
  subscribeToAgentRegistered,
  subscribeToAgentUpdated,
  subscribeToAgentDeregistered,
  subscribeToAllAgentEvents,
  type AgentEventCallback,
  type EventSubscription,
  type AgentEventCallbacks,
  type EventSubscriptionOptions,
} from './events.js';

// AgentManager class
export { AgentManager, type AgentManagerConfig } from './manager.js';
