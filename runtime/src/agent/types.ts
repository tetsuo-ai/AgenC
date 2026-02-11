import { PublicKey } from '@solana/web3.js';
import {
  Capability,
  ALL_CAPABILITY_NAMES,
  hasCapability,
  getCapabilityNames,
  parseCapabilities,
  type CapabilityName,
} from './capabilities.js';
import { toUint8Array } from '../utils/encoding.js';

// Re-export capability functions from canonical source
export { hasCapability, getCapabilityNames, type CapabilityName };

// ============================================================================
// Constants (no magic numbers)
// ============================================================================

/** Account size for AgentRegistration (includes 8-byte discriminator) */
export const AGENT_REGISTRATION_SIZE = 438;

/** Length of agent_id field (bytes) */
export const AGENT_ID_LENGTH = 32;

/** Maximum length of endpoint string (chars) */
export const MAX_ENDPOINT_LENGTH = 128;

/** Maximum length of metadata_uri string (chars) */
export const MAX_METADATA_URI_LENGTH = 128;

/** Maximum reputation value (0-10000, representing 0.00% - 100.00%) */
export const MAX_REPUTATION = 10000;

/** Maximum value for u8 fields (active_tasks, task_count_24h, etc.) */
export const MAX_U8 = 255;

// ============================================================================
// Capability Constants (aliases for backwards compatibility)
// ============================================================================

/**
 * Agent capability bitmask constants.
 * Each capability is a power of 2 allowing bitwise combination.
 *
 * @remarks
 * This is an alias for {@link Capability} for backwards compatibility.
 * Prefer using `Capability` from `./capabilities.js` for new code.
 *
 * @example
 * ```typescript
 * // Agent with compute and inference capabilities
 * const caps = AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE;
 *
 * // Check if agent can perform ML inference
 * if (hasCapability(caps, AgentCapabilities.INFERENCE)) { ... }
 * ```
 */
export const AgentCapabilities = Capability;

/** Type for individual capability values */
export type AgentCapability = (typeof AgentCapabilities)[keyof typeof AgentCapabilities];

/**
 * All capability names for iteration.
 * @remarks Alias for {@link ALL_CAPABILITY_NAMES} for backwards compatibility.
 */
export const CAPABILITY_NAMES = ALL_CAPABILITY_NAMES;

// ============================================================================
// AgentStatus Enum (matches state.rs AgentStatus)
// ============================================================================

/**
 * Agent status values matching on-chain enum.
 * Stored as u8 on-chain with repr(u8).
 */
export enum AgentStatus {
  /** Agent is registered but not active */
  Inactive = 0,
  /** Agent is active and can accept tasks */
  Active = 1,
  /** Agent is currently processing tasks */
  Busy = 2,
  /** Agent is suspended (e.g., due to disputes) */
  Suspended = 3,
}

/**
 * Converts AgentStatus enum to human-readable string.
 *
 * @param status - The agent status value
 * @returns Human-readable status string
 *
 * @example
 * ```typescript
 * agentStatusToString(AgentStatus.Active); // "Active"
 * agentStatusToString(99 as AgentStatus);  // "Unknown (99)"
 * ```
 */
export function agentStatusToString(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.Inactive:
      return 'Inactive';
    case AgentStatus.Active:
      return 'Active';
    case AgentStatus.Busy:
      return 'Busy';
    case AgentStatus.Suspended:
      return 'Suspended';
    default:
      return `Unknown (${status})`;
  }
}

/**
 * Type guard to check if a number is a valid AgentStatus.
 *
 * @param value - Value to check
 * @returns True if value is a valid AgentStatus (0-3)
 *
 * @example
 * ```typescript
 * if (isValidAgentStatus(statusFromChain)) {
 *   // statusFromChain is typed as AgentStatus
 * }
 * ```
 */
export function isValidAgentStatus(value: number): value is AgentStatus {
  return (
    Number.isInteger(value) &&
    value >= AgentStatus.Inactive &&
    value <= AgentStatus.Suspended
  );
}

// ============================================================================
// Capability Helper Functions
// ============================================================================

// Note: hasCapability and getCapabilityNames are imported from ./capabilities.js
// and re-exported above for backwards compatibility.

/**
 * Creates a capability bitmask from an array of capability names.
 *
 * @remarks
 * This is a wrapper around {@link parseCapabilities} that accepts readonly arrays.
 *
 * @param names - Array of capability names
 * @returns Combined capability bitmask
 *
 * @example
 * ```typescript
 * const caps = createCapabilityMask(['COMPUTE', 'INFERENCE']);
 * // caps === AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE
 * ```
 */
export function createCapabilityMask(names: readonly CapabilityName[]): bigint {
  return parseCapabilities([...names]);
}

// ============================================================================
// AgentState Interface (mirrors state.rs AgentRegistration)
// ============================================================================

/**
 * Agent registration state from the on-chain AgentRegistration account.
 * PDA seeds: ["agent", agent_id]
 *
 * All 22 fields from the on-chain structure (excluding _reserved).
 */
export interface AgentState {
  // === Identity ===
  /** Unique agent identifier (32 bytes) */
  agentId: Uint8Array;
  /** Agent's signing authority (wallet address) */
  authority: PublicKey;
  /** PDA bump seed */
  bump: number;

  // === Capabilities & Status ===
  /** Capability bitmask (u64 as bigint) */
  capabilities: bigint;
  /** Current agent status */
  status: AgentStatus;

  // === Registration & Activity ===
  /** Registration timestamp (Unix seconds) */
  registeredAt: number;
  /** Last activity timestamp (Unix seconds) */
  lastActive: number;
  /** Network endpoint URL (max 128 chars) */
  endpoint: string;
  /** Extended metadata URI (max 128 chars) */
  metadataUri: string;

  // === Performance Metrics ===
  /** Total tasks completed */
  tasksCompleted: bigint;
  /** Total rewards earned (lamports) */
  totalEarned: bigint;
  /** Reputation score (0-10000, representing 0.00%-100.00%) */
  reputation: number;
  /** Current active task count */
  activeTasks: number;
  /** Stake amount for arbiter role (lamports) */
  stake: bigint;

  // === Rate Limiting ===
  /** Timestamp of last task creation (Unix seconds) */
  lastTaskCreated: number;
  /** Timestamp of last dispute initiated (Unix seconds) */
  lastDisputeInitiated: number;
  /** Tasks created in current 24h window */
  taskCount24h: number;
  /** Disputes initiated in current 24h window */
  disputeCount24h: number;
  /** Start of current rate limit window (Unix seconds) */
  rateLimitWindowStart: number;

  // === Dispute Activity ===
  /** Active dispute votes pending resolution */
  activeDisputeVotes: number;
  /** Timestamp of last dispute vote (Unix seconds) */
  lastVoteTimestamp: number;

  // === State Sync ===
  /** Timestamp of last state update (Unix seconds) */
  lastStateUpdate: number;
}

// ============================================================================
// Parameter Interfaces
// ============================================================================

/**
 * Parameters for agent registration instruction.
 */
export interface AgentRegistrationParams {
  /** Unique agent identifier (32 bytes) */
  agentId: Uint8Array;
  /** Initial capability bitmask */
  capabilities: bigint;
  /** Network endpoint URL */
  endpoint: string;
  /** Optional metadata URI */
  metadataUri?: string;
  /** Initial stake amount (lamports) */
  stakeAmount: bigint;
}

/**
 * Parameters for agent update instruction.
 * All fields optional - only provided fields will be updated.
 */
export interface AgentUpdateParams {
  /** New capability bitmask */
  capabilities?: bigint;
  /** New endpoint URL */
  endpoint?: string;
  /** New metadata URI */
  metadataUri?: string;
  /** New status */
  status?: AgentStatus;
}

/**
 * Computed rate limit state for an agent.
 * Derived from agent state and protocol config.
 */
export interface RateLimitState {
  /** Whether the agent can create a new task */
  canCreateTask: boolean;
  /** Whether the agent can initiate a dispute */
  canInitiateDispute: boolean;
  /** Unix timestamp when task cooldown ends (0 if ready) */
  taskCooldownEnds: number;
  /** Unix timestamp when dispute cooldown ends (0 if ready) */
  disputeCooldownEnds: number;
  /** Tasks remaining in current 24h window */
  tasksRemainingIn24h: number;
  /** Disputes remaining in current 24h window */
  disputesRemainingIn24h: number;
}

// ============================================================================
// Event Interfaces (mirrors events.rs agent events)
// ============================================================================

/**
 * Event emitted when a new agent registers.
 * On-chain event name: AgentRegistered
 */
export interface AgentRegisteredEvent {
  /** Agent identifier (32 bytes) */
  agentId: Uint8Array;
  /** Agent's signing authority */
  authority: PublicKey;
  /** Initial capabilities bitmask */
  capabilities: bigint;
  /** Network endpoint URL */
  endpoint: string;
  /** Event timestamp (Unix seconds) */
  timestamp: number;
}

/**
 * Event emitted when an agent updates its registration.
 * On-chain event name: AgentUpdated
 *
 * Note: capabilities is always present in the event (not optional).
 */
export interface AgentUpdatedEvent {
  /** Agent identifier (32 bytes) */
  agentId: Uint8Array;
  /** Updated capabilities bitmask */
  capabilities: bigint;
  /** Updated status (as u8 value) */
  status: number;
  /** Event timestamp (Unix seconds) */
  timestamp: number;
}

/**
 * Event emitted when an agent deregisters.
 * On-chain event name: AgentDeregistered
 */
export interface AgentDeregisteredEvent {
  /** Agent identifier (32 bytes) */
  agentId: Uint8Array;
  /** Agent's signing authority */
  authority: PublicKey;
  /** Event timestamp (Unix seconds) */
  timestamp: number;
}

// ============================================================================
// Raw Data Type Guards (for parsing Anchor account data)
// ============================================================================

/**
 * Checks if a value is a BN-like object with toString method (for u64 fields).
 */
function isBNLike(value: unknown): value is { toString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).toString === 'function'
  );
}

/**
 * Checks if a value is a BN-like object with toNumber method (for i64 fields).
 */
function isBNLikeWithToNumber(value: unknown): value is { toNumber: () => number } {
  return (
    isBNLike(value) && typeof (value as Record<string, unknown>).toNumber === 'function'
  );
}

/**
 * Raw agent registration data shape from Anchor.
 * BN fields will be converted to number/bigint.
 */
interface RawAgentRegistrationData {
  agentId: number[] | Uint8Array;
  authority: PublicKey;
  capabilities: { toString: () => string };
  status: { inactive?: object; active?: object; busy?: object; suspended?: object } | number;
  endpoint: string;
  metadataUri: string;
  registeredAt: { toNumber: () => number };
  lastActive: { toNumber: () => number };
  tasksCompleted: { toString: () => string };
  totalEarned: { toString: () => string };
  reputation: number;
  activeTasks: number;
  stake: { toString: () => string };
  bump: number;
  lastTaskCreated: { toNumber: () => number };
  lastDisputeInitiated: { toNumber: () => number };
  taskCount24h: number;
  disputeCount24h: number;
  rateLimitWindowStart: { toNumber: () => number };
  activeDisputeVotes: number;
  lastVoteTimestamp: { toNumber: () => number };
  lastStateUpdate: { toNumber: () => number };
}

/**
 * Type guard to check if a value has the shape of raw agent registration data.
 * Validates all 22 required fields.
 */
function isRawAgentRegistrationData(data: unknown): data is RawAgentRegistrationData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Validate agentId (array or Uint8Array)
  if (!Array.isArray(obj.agentId) && !(obj.agentId instanceof Uint8Array)) {
    return false;
  }

  // Validate PublicKey field
  if (!(obj.authority instanceof PublicKey)) {
    return false;
  }

  // Validate BN-like fields (u64 - need toString for bigint conversion)
  if (!isBNLike(obj.capabilities)) return false;
  if (!isBNLike(obj.tasksCompleted)) return false;
  if (!isBNLike(obj.totalEarned)) return false;
  if (!isBNLike(obj.stake)) return false;

  // Validate BN-like fields (i64 - need toNumber for timestamp conversion)
  if (!isBNLikeWithToNumber(obj.registeredAt)) return false;
  if (!isBNLikeWithToNumber(obj.lastActive)) return false;
  if (!isBNLikeWithToNumber(obj.lastTaskCreated)) return false;
  if (!isBNLikeWithToNumber(obj.lastDisputeInitiated)) return false;
  if (!isBNLikeWithToNumber(obj.rateLimitWindowStart)) return false;
  if (!isBNLikeWithToNumber(obj.lastVoteTimestamp)) return false;
  if (!isBNLikeWithToNumber(obj.lastStateUpdate)) return false;

  // Validate string fields
  if (typeof obj.endpoint !== 'string') return false;
  if (typeof obj.metadataUri !== 'string') return false;

  // Validate number fields (u8, u16)
  if (typeof obj.reputation !== 'number') return false;
  if (typeof obj.activeTasks !== 'number') return false;
  if (typeof obj.bump !== 'number') return false;
  if (typeof obj.taskCount24h !== 'number') return false;
  if (typeof obj.disputeCount24h !== 'number') return false;
  if (typeof obj.activeDisputeVotes !== 'number') return false;

  // Status can be object (Anchor enum) or number
  if (typeof obj.status !== 'object' && typeof obj.status !== 'number') return false;

  return true;
}

/**
 * Parses the AgentStatus from Anchor's enum representation.
 * Anchor enums can come as objects like { active: {} } or numbers.
 */
function parseAgentStatus(
  status: { inactive?: object; active?: object; busy?: object; suspended?: object } | number
): AgentStatus {
  // Handle numeric status (already parsed)
  if (typeof status === 'number') {
    if (!isValidAgentStatus(status)) {
      throw new Error(`Invalid agent status value: ${status}`);
    }
    return status;
  }

  // Handle Anchor enum object format
  if ('inactive' in status) return AgentStatus.Inactive;
  if ('active' in status) return AgentStatus.Active;
  if ('busy' in status) return AgentStatus.Busy;
  if ('suspended' in status) return AgentStatus.Suspended;

  throw new Error('Invalid agent status format');
}

/**
 * Safely converts a BN-like value to bigint.
 */
function toBigInt(value: { toString: () => string }): bigint {
  return BigInt(value.toString());
}

// ============================================================================
// Main Parse Function
// ============================================================================

/**
 * Parses raw Anchor account data into a typed AgentState.
 *
 * @param data - Raw account data from Anchor program.account.agentRegistration.fetch()
 * @returns Parsed AgentState with proper TypeScript types
 * @throws Error if required fields are missing, invalid, or out of range
 *
 * @example
 * ```typescript
 * const rawData = await program.account.agentRegistration.fetch(agentPda);
 * const agent = parseAgentState(rawData);
 * console.log(`Agent status: ${agentStatusToString(agent.status)}`);
 * console.log(`Capabilities: ${getCapabilityNames(agent.capabilities).join(', ')}`);
 * ```
 */
export function parseAgentState(data: unknown): AgentState {
  // 1. Validate with type guard
  if (!isRawAgentRegistrationData(data)) {
    throw new Error('Invalid agent registration data: missing required fields');
  }

  // 2. Convert and validate agentId
  const agentId = toUint8Array(data.agentId);
  if (agentId.length !== AGENT_ID_LENGTH) {
    throw new Error(
      `Invalid agentId length: ${agentId.length} (must be ${AGENT_ID_LENGTH})`
    );
  }

  // 3. Range validation for u16 field
  if (data.reputation > MAX_REPUTATION) {
    throw new Error(
      `Invalid reputation: ${data.reputation} (must be 0-${MAX_REPUTATION})`
    );
  }

  // 4. Range validation for u8 fields
  if (data.activeTasks > MAX_U8) {
    throw new Error(`Invalid activeTasks: ${data.activeTasks} (must be 0-${MAX_U8})`);
  }
  if (data.taskCount24h > MAX_U8) {
    throw new Error(`Invalid taskCount24h: ${data.taskCount24h} (must be 0-${MAX_U8})`);
  }
  if (data.disputeCount24h > MAX_U8) {
    throw new Error(
      `Invalid disputeCount24h: ${data.disputeCount24h} (must be 0-${MAX_U8})`
    );
  }
  if (data.activeDisputeVotes > MAX_U8) {
    throw new Error(
      `Invalid activeDisputeVotes: ${data.activeDisputeVotes} (must be 0-${MAX_U8})`
    );
  }
  if (data.bump > MAX_U8) {
    throw new Error(`Invalid bump: ${data.bump} (must be 0-${MAX_U8})`);
  }

  // 5. String length validation
  if (data.endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error(
      `Invalid endpoint length: ${data.endpoint.length} (must be <= ${MAX_ENDPOINT_LENGTH})`
    );
  }
  if (data.metadataUri.length > MAX_METADATA_URI_LENGTH) {
    throw new Error(
      `Invalid metadataUri length: ${data.metadataUri.length} (must be <= ${MAX_METADATA_URI_LENGTH})`
    );
  }

  // 6. Parse status enum
  const status = parseAgentStatus(data.status);

  // 7. Convert and return typed object
  return {
    // Identity
    agentId,
    authority: data.authority,
    bump: data.bump,

    // Capabilities & Status
    capabilities: toBigInt(data.capabilities),
    status,

    // Registration & Activity
    registeredAt: data.registeredAt.toNumber(),
    lastActive: data.lastActive.toNumber(),
    endpoint: data.endpoint,
    metadataUri: data.metadataUri,

    // Performance Metrics
    tasksCompleted: toBigInt(data.tasksCompleted),
    totalEarned: toBigInt(data.totalEarned),
    reputation: data.reputation,
    activeTasks: data.activeTasks,
    stake: toBigInt(data.stake),

    // Rate Limiting
    lastTaskCreated: data.lastTaskCreated.toNumber(),
    lastDisputeInitiated: data.lastDisputeInitiated.toNumber(),
    taskCount24h: data.taskCount24h,
    disputeCount24h: data.disputeCount24h,
    rateLimitWindowStart: data.rateLimitWindowStart.toNumber(),

    // Dispute Activity
    activeDisputeVotes: data.activeDisputeVotes,
    lastVoteTimestamp: data.lastVoteTimestamp.toNumber(),

    // State Sync
    lastStateUpdate: data.lastStateUpdate.toNumber(),
  };
}

// ============================================================================
// Rate Limit Helpers
// ============================================================================

/**
 * Computes the rate limit state for an agent given the current time and protocol config.
 *
 * @param agent - The agent state
 * @param config - Rate limit configuration from protocol
 * @param nowUnix - Current Unix timestamp (seconds)
 * @returns Computed rate limit state
 *
 * @example
 * ```typescript
 * const rateLimits = computeRateLimitState(agent, {
 *   taskCreationCooldown: 60,
 *   maxTasksPer24h: 50,
 *   disputeInitiationCooldown: 300,
 *   maxDisputesPer24h: 10,
 * }, Math.floor(Date.now() / 1000));
 *
 * if (!rateLimits.canCreateTask) {
 *   console.log(`Must wait until ${new Date(rateLimits.taskCooldownEnds * 1000)}`);
 * }
 * ```
 */
export function computeRateLimitState(
  agent: Pick<
    AgentState,
    | 'lastTaskCreated'
    | 'lastDisputeInitiated'
    | 'taskCount24h'
    | 'disputeCount24h'
    | 'rateLimitWindowStart'
  >,
  config: {
    taskCreationCooldown: number;
    maxTasksPer24h: number;
    disputeInitiationCooldown: number;
    maxDisputesPer24h: number;
  },
  nowUnix: number
): RateLimitState {
  const SECONDS_PER_24H = 86400;

  // Check if 24h window has expired and needs reset
  const windowExpired = nowUnix - agent.rateLimitWindowStart >= SECONDS_PER_24H;

  // Effective counts (reset if window expired)
  const effectiveTaskCount = windowExpired ? 0 : agent.taskCount24h;
  const effectiveDisputeCount = windowExpired ? 0 : agent.disputeCount24h;

  // Task cooldown
  const taskCooldownEnds =
    config.taskCreationCooldown > 0
      ? agent.lastTaskCreated + config.taskCreationCooldown
      : 0;
  const taskCooldownPassed = nowUnix >= taskCooldownEnds;

  // Dispute cooldown
  const disputeCooldownEnds =
    config.disputeInitiationCooldown > 0
      ? agent.lastDisputeInitiated + config.disputeInitiationCooldown
      : 0;
  const disputeCooldownPassed = nowUnix >= disputeCooldownEnds;

  // 24h limits (0 = unlimited)
  const tasksRemaining =
    config.maxTasksPer24h === 0
      ? MAX_U8
      : Math.max(0, config.maxTasksPer24h - effectiveTaskCount);
  const disputesRemaining =
    config.maxDisputesPer24h === 0
      ? MAX_U8
      : Math.max(0, config.maxDisputesPer24h - effectiveDisputeCount);

  return {
    canCreateTask: taskCooldownPassed && tasksRemaining > 0,
    canInitiateDispute: disputeCooldownPassed && disputesRemaining > 0,
    taskCooldownEnds: taskCooldownPassed ? 0 : taskCooldownEnds,
    disputeCooldownEnds: disputeCooldownPassed ? 0 : disputeCooldownEnds,
    tasksRemainingIn24h: tasksRemaining,
    disputesRemainingIn24h: disputesRemaining,
  };
}
