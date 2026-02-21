/**
 * Collaboration protocol types, constants, and configuration interfaces.
 *
 * Provides types for agent team formation via the feed:
 * - CollaborationRequest (what an agent posts to find collaborators)
 * - CollaborationResponse (how agents respond to requests)
 * - CollaborationRequestState (internal tracking of request lifecycle)
 *
 * @module
 */

import type { PublicKey, Keypair } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../idl.js";
import type { Logger } from "../utils/logger.js";
import type { TeamPayoutConfig } from "../team/types.js";
import type { TeamContractEngine } from "../team/engine.js";
import type { AgentFeed } from "./feed.js";
import type { AgentMessaging } from "./messaging.js";
import type { AgentDiscovery } from "./discovery.js";
import type { ReputationSignalCallback } from "./reputation-types.js";

// ============================================================================
// Constants
// ============================================================================

/** Well-known 32-byte topic for collaboration request feed posts ("collab\0\0" + 24 zero bytes) */
export const COLLABORATION_TOPIC = new Uint8Array([
  0x63,
  0x6f,
  0x6c,
  0x6c,
  0x61,
  0x62,
  0x00,
  0x00, // "collab\0\0"
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]);

/** Maximum length of a collaboration request title */
export const MAX_TITLE_LENGTH = 128;

/** Maximum length of a collaboration request description */
export const MAX_DESCRIPTION_LENGTH = 2048;

/** Maximum number of members in a collaboration */
export const MAX_COLLABORATION_MEMBERS = 20;

// ============================================================================
// Core Types
// ============================================================================

/** A collaboration request posted to the feed */
export interface CollaborationRequest {
  /** Short title describing the collaboration need */
  title: string;
  /** Detailed description of the task/collaboration */
  description: string;
  /** Required capability bitmask (agents must match) */
  requiredCapabilities: bigint;
  /** Maximum number of team members */
  maxMembers: number;
  /** Payout configuration for the team contract */
  payoutModel: TeamPayoutConfig;
  /** Optional deadline (Unix seconds) */
  deadline?: number;
}

/** Status of a collaboration request */
export type CollaborationRequestStatus =
  | "open"
  | "forming"
  | "formed"
  | "expired"
  | "cancelled";

/** A response from an agent to a collaboration request */
export interface CollaborationResponse {
  /** PDA of the responding agent */
  agentPda: PublicKey;
  /** Whether the agent accepted the collaboration */
  accepted: boolean;
  /** Capabilities offered by the responding agent */
  capabilities: bigint;
  /** Unix timestamp of response */
  respondedAt: number;
}

/** Internal state tracking for a collaboration request */
export interface CollaborationRequestState {
  /** Unique request identifier (postPda base58) */
  requestId: string;
  /** The original collaboration request */
  request: CollaborationRequest;
  /** PDA of the feed post */
  postPda: PublicKey;
  /** PDA of the requesting agent */
  requesterPda: PublicKey;
  /** Current status */
  status: CollaborationRequestStatus;
  /** Collected responses */
  responses: CollaborationResponse[];
  /** Team contract ID (set after formation) */
  teamContractId: string | null;
  /** SHA-256 hash of the request metadata */
  contentHash: Uint8Array;
  /** Random nonce used for the feed post */
  nonce: Uint8Array;
  /** Creation timestamp (Unix seconds) */
  createdAt: number;
}

/** JSON metadata structure hashed for contentHash */
export interface CollaborationRequestMetadata {
  type: "collaboration_request";
  version: 1;
  title: string;
  description: string;
  requiredCapabilities: string;
  maxMembers: number;
  payoutModel: TeamPayoutConfig;
  deadline?: number;
}

// ============================================================================
// Configuration
// ============================================================================

/** Optional configuration for CollaborationProtocol */
export interface CollaborationConfig {
  /** Optional logger */
  logger?: Logger;
  /** Optional callback for reputation-relevant signals */
  onReputationSignal?: ReputationSignalCallback;
  /** Override the collaboration topic (default: COLLABORATION_TOPIC) */
  collaborationTopic?: Uint8Array;
}

/** Constructor config for CollaborationProtocol */
export interface CollaborationOpsConfig {
  /** Anchor program instance */
  program: Program<AgencCoordination>;
  /** 32-byte agent identifier */
  agentId: Uint8Array;
  /** Keypair for signing transactions */
  wallet: Keypair;
  /** AgentFeed instance for posting collaboration requests */
  feed: AgentFeed;
  /** AgentMessaging instance for communicating with collaborators */
  messaging: AgentMessaging;
  /** AgentDiscovery instance for finding collaborators */
  discovery: AgentDiscovery;
  /** TeamContractEngine for forming and managing teams */
  teamEngine: TeamContractEngine;
  /** Optional configuration */
  config?: CollaborationConfig;
}
