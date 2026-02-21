import { PublicKey } from '@solana/web3.js';

/** Maximum number of multisig owners */
export const MAX_MULTISIG_OWNERS = 5;

/**
 * Protocol configuration account data.
 * Mirrors the on-chain ProtocolConfig account structure (excluding internal padding).
 * PDA seeds: ["protocol"]
 */
export interface ProtocolConfig {
  /** Protocol authority */
  authority: PublicKey;

  /** Treasury for protocol fees */
  treasury: PublicKey;

  /** Minimum votes needed to resolve dispute (percentage, 1-100) */
  disputeThreshold: number;

  /** Protocol fee in basis points (1/100th of a percent) */
  protocolFeeBps: number;

  /** Minimum stake required to register as arbiter (lamports) */
  minArbiterStake: bigint;

  /** Minimum stake required to register as agent (lamports) */
  minAgentStake: bigint;

  /** Max duration (seconds) a claim can stay active without completion */
  maxClaimDuration: number;

  /** Max duration (seconds) a dispute can remain active */
  maxDisputeDuration: number;

  /** Total registered agents */
  totalAgents: bigint;

  /** Total tasks created */
  totalTasks: bigint;

  /** Total tasks completed */
  completedTasks: bigint;

  /** Total value distributed (lamports) */
  totalValueDistributed: bigint;

  /** Bump seed for PDA */
  bump: number;

  /** Multisig threshold */
  multisigThreshold: number;

  /** Length of configured multisig owners */
  multisigOwnersLen: number;

  /** Minimum cooldown between task creations (seconds, 0 = disabled) */
  taskCreationCooldown: number;

  /** Maximum tasks an agent can create per 24h window (0 = unlimited) */
  maxTasksPer24h: number;

  /** Minimum cooldown between dispute initiations (seconds, 0 = disabled) */
  disputeInitiationCooldown: number;

  /** Maximum disputes an agent can initiate per 24h window (0 = unlimited) */
  maxDisputesPer24h: number;

  /** Minimum stake required to initiate a dispute (griefing resistance, lamports) */
  minStakeForDispute: bigint;

  /** Percentage of stake slashed on losing dispute (0-100) */
  slashPercentage: number;

  /** Cooldown between agent state updates (seconds, 0 = disabled) */
  stateUpdateCooldown: number;

  /** Voting period for disputes (seconds) */
  votingPeriod: number;

  /** Current protocol version (for upgrades) */
  protocolVersion: number;

  /** Minimum supported version for backward compatibility */
  minSupportedVersion: number;

  /** Multisig owners (sliced to actual length) */
  multisigOwners: PublicKey[];
}

/**
 * Raw account data shape from Anchor.
 * BN fields will be converted to number/bigint.
 */
interface RawProtocolConfigData {
  authority: unknown;
  treasury: unknown;
  disputeThreshold: number;
  protocolFeeBps: number;
  minArbiterStake: { toNumber?: () => number; toString: () => string };
  minAgentStake: { toNumber?: () => number; toString: () => string };
  maxClaimDuration: { toNumber: () => number };
  maxDisputeDuration: { toNumber: () => number };
  totalAgents: { toNumber?: () => number; toString: () => string };
  totalTasks: { toNumber?: () => number; toString: () => string };
  completedTasks: { toNumber?: () => number; toString: () => string };
  totalValueDistributed: { toNumber?: () => number; toString: () => string };
  bump: number;
  multisigThreshold: number;
  multisigOwnersLen: number;
  taskCreationCooldown: { toNumber: () => number };
  maxTasksPer24h?: number;
  maxTasksPer24H?: number;
  disputeInitiationCooldown: { toNumber: () => number };
  maxDisputesPer24h?: number;
  maxDisputesPer24H?: number;
  minStakeForDispute: { toNumber?: () => number; toString: () => string };
  slashPercentage: number;
  stateUpdateCooldown?: { toNumber: () => number };
  votingPeriod?: { toNumber: () => number };
  protocolVersion: number;
  minSupportedVersion: number;
  multisigOwners: unknown[];
}

/**
 * Legacy on-chain ProtocolConfig shape used by older deployed program versions.
 *
 * This shape predates extended rate-limit/state-version fields and stores only
 * the core protocol configuration. We still parse it to maintain runtime
 * compatibility with older program binaries used in tests and local setups.
 */
interface LegacyRawProtocolConfigData {
  authority: unknown;
  treasury: unknown;
  disputeThreshold: number;
  protocolFeeBps: number;
  minArbiterStake: { toNumber?: () => number; toString: () => string };
  totalAgents: { toNumber?: () => number; toString: () => string };
  totalTasks: { toNumber?: () => number; toString: () => string };
  completedTasks: { toNumber?: () => number; toString: () => string };
  totalValueDistributed: { toNumber?: () => number; toString: () => string };
  bump: number;
}

/**
 * Checks if a value is a BN-like object with toString method
 */
function isBNLike(value: unknown): value is { toString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).toString === 'function'
  );
}

/**
 * Checks if a value is a BN-like object with toNumber method (for i64 fields)
 */
function isBNLikeWithToNumber(value: unknown): value is { toNumber: () => number } {
  return (
    isBNLike(value) && typeof (value as Record<string, unknown>).toNumber === 'function'
  );
}

function isPublicKeyLike(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      // Reject non-base58 garbage early so parse errors remain deterministic.
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  }
  if (value instanceof PublicKey) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toBase58 === 'function' ||
    typeof candidate.toBytes === 'function'
  );
}

function toPublicKey(value: unknown): PublicKey {
  if (value instanceof PublicKey) {
    return value;
  }
  if (typeof value === 'string') {
    return new PublicKey(value);
  }
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { toBytes?: () => Uint8Array; toBase58?: () => string };
    if (typeof candidate.toBytes === 'function') {
      return new PublicKey(candidate.toBytes());
    }
    if (typeof candidate.toBase58 === 'function') {
      return new PublicKey(candidate.toBase58());
    }
  }
  throw new Error('Invalid public key value');
}

/**
 * Type guard to check if a value has the shape of raw protocol config data.
 * Validates all required fields used by parseProtocolConfig.
 */
function isRawProtocolConfigData(data: unknown): data is RawProtocolConfigData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Validate PublicKey fields
  if (!isPublicKeyLike(obj.authority)) return false;
  if (!isPublicKeyLike(obj.treasury)) return false;

  // Validate number fields (u8, u16)
  if (typeof obj.disputeThreshold !== 'number') return false;
  if (typeof obj.protocolFeeBps !== 'number') return false;
  if (typeof obj.bump !== 'number') return false;
  if (typeof obj.multisigThreshold !== 'number') return false;
  if (typeof obj.multisigOwnersLen !== 'number') return false;
  const hasMaxTasksPer24h =
    typeof obj.maxTasksPer24h === 'number' || typeof obj.maxTasksPer24H === 'number';
  if (!hasMaxTasksPer24h) return false;
  const hasMaxDisputesPer24h =
    typeof obj.maxDisputesPer24h === 'number' || typeof obj.maxDisputesPer24H === 'number';
  if (!hasMaxDisputesPer24h) return false;
  if (typeof obj.slashPercentage !== 'number') return false;
  if (typeof obj.protocolVersion !== 'number') return false;
  if (typeof obj.minSupportedVersion !== 'number') return false;

  // Validate BN-like fields (u64 - need toString for bigint conversion)
  if (!isBNLike(obj.minArbiterStake)) return false;
  if (!isBNLike(obj.minAgentStake)) return false;
  if (!isBNLike(obj.totalAgents)) return false;
  if (!isBNLike(obj.totalTasks)) return false;
  if (!isBNLike(obj.completedTasks)) return false;
  if (!isBNLike(obj.totalValueDistributed)) return false;
  if (!isBNLike(obj.minStakeForDispute)) return false;

  // Validate BN-like fields (i64 - need toNumber for duration conversion)
  if (!isBNLikeWithToNumber(obj.maxClaimDuration)) return false;
  if (!isBNLikeWithToNumber(obj.maxDisputeDuration)) return false;
  if (!isBNLikeWithToNumber(obj.taskCreationCooldown)) return false;
  if (!isBNLikeWithToNumber(obj.disputeInitiationCooldown)) return false;
  if (obj.stateUpdateCooldown !== undefined && !isBNLikeWithToNumber(obj.stateUpdateCooldown)) {
    return false;
  }
  if (obj.votingPeriod !== undefined && !isBNLikeWithToNumber(obj.votingPeriod)) {
    return false;
  }

  // Validate array field and its contents
  if (!Array.isArray(obj.multisigOwners)) return false;
  if (!obj.multisigOwners.every((pk) => isPublicKeyLike(pk))) return false;

  return true;
}

/**
 * Type guard for legacy protocol config account shape.
 */
function isLegacyRawProtocolConfigData(data: unknown): data is LegacyRawProtocolConfigData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Only treat this as legacy when extended modern fields are absent.
  // This avoids accepting malformed modern payloads via legacy fallback.
  if (obj.minAgentStake !== undefined) return false;
  if (obj.maxClaimDuration !== undefined) return false;
  if (obj.maxDisputeDuration !== undefined) return false;
  if (obj.multisigThreshold !== undefined) return false;
  if (obj.multisigOwnersLen !== undefined) return false;
  if (obj.taskCreationCooldown !== undefined) return false;
  if (obj.maxTasksPer24h !== undefined || obj.maxTasksPer24H !== undefined) return false;
  if (obj.disputeInitiationCooldown !== undefined) return false;
  if (obj.maxDisputesPer24h !== undefined || obj.maxDisputesPer24H !== undefined) return false;
  if (obj.minStakeForDispute !== undefined) return false;
  if (obj.slashPercentage !== undefined) return false;
  if (obj.stateUpdateCooldown !== undefined) return false;
  if (obj.votingPeriod !== undefined) return false;
  if (obj.protocolVersion !== undefined) return false;
  if (obj.minSupportedVersion !== undefined) return false;
  if (obj.multisigOwners !== undefined) return false;

  if (!isPublicKeyLike(obj.authority)) return false;
  if (!isPublicKeyLike(obj.treasury)) return false;
  if (typeof obj.disputeThreshold !== 'number') return false;
  if (typeof obj.protocolFeeBps !== 'number') return false;
  if (typeof obj.bump !== 'number') return false;

  if (!isBNLike(obj.minArbiterStake)) return false;
  if (!isBNLike(obj.totalAgents)) return false;
  if (!isBNLike(obj.totalTasks)) return false;
  if (!isBNLike(obj.completedTasks)) return false;
  if (!isBNLike(obj.totalValueDistributed)) return false;

  return true;
}

/**
 * Safely converts a BN-like value to bigint.
 * Handles Anchor's BN type which has toString() method.
 */
function toBigInt(value: { toString: () => string }): bigint {
  return BigInt(value.toString());
}

function parseModernProtocolConfig(data: RawProtocolConfigData): ProtocolConfig {
  const maxTasksPer24h =
    typeof data.maxTasksPer24h === 'number' ? data.maxTasksPer24h : data.maxTasksPer24H;
  const maxDisputesPer24h =
    typeof data.maxDisputesPer24h === 'number'
      ? data.maxDisputesPer24h
      : data.maxDisputesPer24H;
  if (maxTasksPer24h === undefined || maxDisputesPer24h === undefined) {
    throw new Error('Invalid protocol config data: missing rate-limit fields');
  }

  // Range validation for protocol fields
  if (data.disputeThreshold < 1 || data.disputeThreshold > 100) {
    throw new Error(
      `Invalid disputeThreshold: ${data.disputeThreshold} (must be 1-100)`
    );
  }

  if (data.protocolFeeBps > 10000) {
    throw new Error(
      `Invalid protocolFeeBps: ${data.protocolFeeBps} (must be <= 10000)`
    );
  }

  if (data.slashPercentage > 100) {
    throw new Error(
      `Invalid slashPercentage: ${data.slashPercentage} (must be 0-100)`
    );
  }

  const multisigOwnersLen = data.multisigOwnersLen;

  // Validate multisigOwnersLen is within bounds
  if (multisigOwnersLen > MAX_MULTISIG_OWNERS) {
    throw new Error(
      `Invalid multisigOwnersLen: ${multisigOwnersLen} exceeds maximum ${MAX_MULTISIG_OWNERS}`
    );
  }

  // Slice multisig owners to actual length
  const multisigOwners = data.multisigOwners.slice(0, multisigOwnersLen);

  return {
    // Authority & Treasury
    authority: toPublicKey(data.authority),
    treasury: toPublicKey(data.treasury),

    // Dispute Settings
    disputeThreshold: data.disputeThreshold,
    protocolFeeBps: data.protocolFeeBps,

    // Stake Requirements (u64 -> bigint)
    minArbiterStake: toBigInt(data.minArbiterStake),
    minAgentStake: toBigInt(data.minAgentStake),

    // Duration Limits (i64 -> number, safe for seconds values)
    maxClaimDuration: data.maxClaimDuration.toNumber(),
    maxDisputeDuration: data.maxDisputeDuration.toNumber(),

    // Statistics (u64 -> bigint for large values)
    totalAgents: toBigInt(data.totalAgents),
    totalTasks: toBigInt(data.totalTasks),
    completedTasks: toBigInt(data.completedTasks),
    totalValueDistributed: toBigInt(data.totalValueDistributed),

    // PDA
    bump: data.bump,

    // Multisig
    multisigThreshold: data.multisigThreshold,
    multisigOwnersLen: multisigOwnersLen,
    multisigOwners: multisigOwners.map((owner) => toPublicKey(owner)),

    // Rate Limiting
    taskCreationCooldown: data.taskCreationCooldown.toNumber(),
    maxTasksPer24h: maxTasksPer24h,
    disputeInitiationCooldown: data.disputeInitiationCooldown.toNumber(),
    maxDisputesPer24h: maxDisputesPer24h,
    minStakeForDispute: toBigInt(data.minStakeForDispute),
    slashPercentage: data.slashPercentage,

    // State Update & Voting
    stateUpdateCooldown: isBNLikeWithToNumber(data.stateUpdateCooldown)
      ? data.stateUpdateCooldown.toNumber()
      : 60,
    votingPeriod: isBNLikeWithToNumber(data.votingPeriod)
      ? data.votingPeriod.toNumber()
      : 86400,

    // Versioning
    protocolVersion: data.protocolVersion,
    minSupportedVersion: data.minSupportedVersion,
  };
}

function parseLegacyProtocolConfig(data: LegacyRawProtocolConfigData): ProtocolConfig {
  // Range validation still applies for legacy accounts.
  if (data.disputeThreshold < 1 || data.disputeThreshold > 100) {
    throw new Error(
      `Invalid disputeThreshold: ${data.disputeThreshold} (must be 1-100)`
    );
  }

  if (data.protocolFeeBps > 10000) {
    throw new Error(
      `Invalid protocolFeeBps: ${data.protocolFeeBps} (must be <= 10000)`
    );
  }

  return {
    authority: toPublicKey(data.authority),
    treasury: toPublicKey(data.treasury),
    disputeThreshold: data.disputeThreshold,
    protocolFeeBps: data.protocolFeeBps,
    minArbiterStake: toBigInt(data.minArbiterStake),
    // Legacy layout had a single minimum stake field; use it for agents as well.
    minAgentStake: toBigInt(data.minArbiterStake),
    maxClaimDuration: 0,
    maxDisputeDuration: 0,
    totalAgents: toBigInt(data.totalAgents),
    totalTasks: toBigInt(data.totalTasks),
    completedTasks: toBigInt(data.completedTasks),
    totalValueDistributed: toBigInt(data.totalValueDistributed),
    bump: data.bump,
    multisigThreshold: 0,
    multisigOwnersLen: 0,
    taskCreationCooldown: 0,
    maxTasksPer24h: 0,
    disputeInitiationCooldown: 0,
    maxDisputesPer24h: 0,
    minStakeForDispute: 0n,
    slashPercentage: 0,
    // Default to current runtime assumption for state update cooldown.
    stateUpdateCooldown: 60,
    votingPeriod: 86400,
    protocolVersion: 1,
    minSupportedVersion: 1,
    multisigOwners: [],
  };
}

/**
 * Parses raw Anchor account data into a typed ProtocolConfig.
 *
 * @param data - Raw account data from Anchor program.account.protocolConfig.fetch()
 * @returns Parsed ProtocolConfig with proper TypeScript types
 * @throws Error if required fields are missing or invalid
 *
 * @example
 * ```typescript
 * const rawData = await program.account.protocolConfig.fetch(protocolPda);
 * const config = parseProtocolConfig(rawData);
 * console.log(`Protocol fee: ${config.protocolFeeBps} bps`);
 * ```
 */
export function parseProtocolConfig(data: unknown): ProtocolConfig {
  if (isRawProtocolConfigData(data)) {
    return parseModernProtocolConfig(data);
  }

  if (isLegacyRawProtocolConfigData(data)) {
    return parseLegacyProtocolConfig(data);
  }

  throw new Error('Invalid protocol config data: missing required fields');
}
