/**
 * @agenc/runtime - Agent runtime infrastructure for AgenC
 * @packageDocumentation
 */

// Re-export SDK constants for convenience
export {
  PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  HASH_SIZE,
  SEEDS,
  TaskState,
  TaskStatus,
} from '@agenc/sdk';

// IDL exports
export {
  IDL,
  type AgencCoordination,
  createProgram,
  createReadOnlyProgram,
} from './idl.js';

export const VERSION = '0.1.0';

/** Runtime configuration options */
export interface AgentRuntimeConfig {
  rpcUrl: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/** Placeholder AgentRuntime class */
export class AgentRuntime {
  private readonly config: AgentRuntimeConfig;

  constructor(config: AgentRuntimeConfig) {
    this.config = config;
  }

  get rpcUrl(): string {
    return this.config.rpcUrl;
  }
}

// Types (protocol and errors)
export {
  // Protocol types
  ProtocolConfig,
  parseProtocolConfig,
  MAX_MULTISIG_OWNERS,
  // Error constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Error types
  type RuntimeErrorCode,
  type AnchorErrorCode,
  type AnchorErrorName,
  type ParsedAnchorError,
  // Error classes
  RuntimeError,
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  // Error helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
  // Agent constants
  AgentCapabilities,
  AGENT_REGISTRATION_SIZE,
  AGENT_ID_LENGTH,
  MAX_ENDPOINT_LENGTH,
  MAX_METADATA_URI_LENGTH,
  MAX_REPUTATION,
  MAX_U8,
  CAPABILITY_NAMES,
  // Agent enum
  AgentStatus,
  // Agent functions
  agentStatusToString,
  isValidAgentStatus,
  hasCapability,
  getCapabilityNames,
  createCapabilityMask,
  parseAgentState,
  computeRateLimitState,
  // Agent types
  type AgentCapability,
  type CapabilityName,
  type AgentState,
  type AgentRegistrationParams,
  type AgentUpdateParams,
  type RateLimitState,
  type AgentRegisteredEvent,
  type AgentUpdatedEvent,
  type AgentDeregisteredEvent,
} from './types/index.js';

// Wallet types and helpers
export {
  Wallet,
  SignMessageWallet,
  KeypairFileError,
  keypairToWallet,
  loadKeypairFromFile,
  loadKeypairFromFileSync,
  getDefaultKeypairPath,
  loadDefaultKeypair,
} from './types/wallet';
