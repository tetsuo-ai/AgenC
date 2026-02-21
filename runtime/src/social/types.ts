/**
 * Agent Discovery types for on-chain agent search.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../idl.js";
import type { Logger } from "../utils/logger.js";
import type { AgentState } from "../agent/types.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Byte offset of the `status` field (u8) in the AgentRegistration account.
 * Layout: discriminator (8) + agent_id (32) + authority (32) + capabilities (8) = 80
 */
export const AGENT_STATUS_OFFSET = 80;

// ============================================================================
// Agent Profile
// ============================================================================

/**
 * Flat profile representing an on-chain AgentRegistration account.
 */
export interface AgentProfile {
  /** PDA address of the agent account */
  pda: PublicKey;
  /** 32-byte agent identifier */
  agentId: Uint8Array;
  /** Agent's signing authority */
  authority: PublicKey;
  /** Capability bitmask (u64 as bigint) */
  capabilities: bigint;
  /** Current status */
  status: number;
  /** Network endpoint URL */
  endpoint: string;
  /** Extended metadata URI */
  metadataUri: string;
  /** Registration timestamp (Unix seconds) */
  registeredAt: number;
  /** Last activity timestamp (Unix seconds) */
  lastActive: number;
  /** Total tasks completed */
  tasksCompleted: bigint;
  /** Total rewards earned (lamports) */
  totalEarned: bigint;
  /** Reputation score (0-10000) */
  reputation: number;
  /** Current active task count */
  activeTasks: number;
  /** Stake amount (lamports) */
  stake: bigint;
}

// ============================================================================
// Search Filters
// ============================================================================

/** Sort field for agent search results */
export type AgentSortField =
  | "reputation"
  | "lastActive"
  | "tasksCompleted"
  | "stake";

/** Sort direction */
export type SortOrder = "asc" | "desc";

/**
 * Filters for agent search queries.
 */
export interface AgentSearchFilters {
  /** Required capability bitmask (AND match) */
  capabilities?: bigint;
  /** Minimum reputation score (0-10000) */
  minReputation?: number;
  /** Only return Active agents (default: true) */
  activeOnly?: boolean;
  /** Only return agents with a non-empty endpoint */
  onlineOnly?: boolean;
  /** Minimum stake amount (lamports) */
  minStake?: bigint;
  /** Maximum results to return */
  maxResults?: number;
  /** Sort field */
  sortBy?: AgentSortField;
  /** Sort order (default: 'desc') */
  sortOrder?: SortOrder;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Cache configuration for agent profiles.
 */
export interface ProfileCacheConfig {
  /** Cache entry TTL in milliseconds (default: 60_000) */
  ttlMs?: number;
  /** Maximum cached entries (default: 200) */
  maxEntries?: number;
}

/**
 * Configuration for AgentDiscovery.
 */
export interface DiscoveryConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** Optional program ID override */
  programId?: PublicKey;
  /** Logger instance */
  logger?: Logger;
  /** Profile cache configuration (omit to disable caching) */
  cache?: ProfileCacheConfig;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert parsed AgentState + PDA into a flat AgentProfile.
 */
export function agentStateToProfile(
  pda: PublicKey,
  state: AgentState,
): AgentProfile {
  return {
    pda,
    agentId: state.agentId,
    authority: state.authority,
    capabilities: state.capabilities,
    status: state.status,
    endpoint: state.endpoint,
    metadataUri: state.metadataUri,
    registeredAt: state.registeredAt,
    lastActive: state.lastActive,
    tasksCompleted: state.tasksCompleted,
    totalEarned: state.totalEarned,
    reputation: state.reputation,
    activeTasks: state.activeTasks,
    stake: state.stake,
  };
}
