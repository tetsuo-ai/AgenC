/**
 * Type definitions for @agenc/runtime
 * @packageDocumentation
 */

// Protocol configuration types
export {
  ProtocolConfig,
  parseProtocolConfig,
  MAX_MULTISIG_OWNERS,
} from './protocol.js';

// Error types, constants, and helpers
export {
  // Constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Types
  RuntimeErrorCode,
  AnchorErrorCode,
  AnchorErrorName,
  ParsedAnchorError,
  // Base error class
  RuntimeError,
  // Specific error classes
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  // Helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
} from './errors.js';

// Agent types and utilities
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
  hasCapability,
  getCapabilityNames,
  createCapabilityMask,
  parseAgentState,
  computeRateLimitState,
  // Types
  type AgentCapability,
  type CapabilityName,
  type AgentState,
  type AgentRegistrationParams,
  type AgentUpdateParams,
  type RateLimitState,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
} from '../agent/index.js';
