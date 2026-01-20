/**
 * Cross-chain bridge utilities for AgenC Protocol
 *
 * Enables cross-chain task coordination via Wormhole or other bridge protocols.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from './constants';

// ============================================================================
// Chain IDs (Wormhole standard)
// ============================================================================

export const ChainId = {
  SOLANA: 1,
  ETHEREUM: 2,
  TERRA: 3,
  BSC: 4,
  POLYGON: 5,
  AVALANCHE: 6,
  OASIS: 7,
  ALGORAND: 8,
  AURORA: 9,
  FANTOM: 10,
  KARURA: 11,
  ACALA: 12,
  KLAYTN: 13,
  CELO: 14,
  NEAR: 15,
  MOONBEAM: 16,
  NEON: 17,
  TERRA2: 18,
  INJECTIVE: 19,
  OSMOSIS: 20,
  SUI: 21,
  APTOS: 22,
  ARBITRUM: 23,
  OPTIMISM: 24,
  GNOSIS: 25,
  BASE: 30,
} as const;

export type ChainIdType = (typeof ChainId)[keyof typeof ChainId];

// ============================================================================
// Cross-Chain Message Types
// ============================================================================

export enum CrossChainMessageType {
  TaskCreated = 0,
  TaskClaimed = 1,
  TaskCompleted = 2,
  TaskCancelled = 3,
  AgentRegistered = 4,
  DisputeInitiated = 5,
  DisputeResolved = 6,
}

// ============================================================================
// Message Structures
// ============================================================================

/**
 * Cross-chain task creation message
 */
export interface CrossChainTaskCreated {
  version: number;
  sourceChain: number;
  taskId: Buffer;
  creator: Buffer;
  requiredCapabilities: bigint;
  descriptionHash: Buffer;
  rewardAmount: bigint;
  deadline: bigint;
  taskType: number;
  constraintHash: Buffer;
  maxWorkers: number;
  nonce: bigint;
  createdAt: bigint;
}

/**
 * Cross-chain task claim message
 */
export interface CrossChainTaskClaimed {
  version: number;
  sourceChain: number;
  workerChain: number;
  taskId: Buffer;
  worker: Buffer;
  workerAgentId: Buffer;
  expiresAt: bigint;
  nonce: bigint;
  claimedAt: bigint;
}

/**
 * Cross-chain task completion message
 */
export interface CrossChainTaskCompleted {
  version: number;
  sourceChain: number;
  workerChain: number;
  taskId: Buffer;
  worker: Buffer;
  proofBinding: Buffer;
  outputCommitment: Buffer;
  resultHash: Buffer;
  proofData: Buffer;
  completedAt: bigint;
  nonce: bigint;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize CrossChainTaskCreated to bytes
 */
export function serializeTaskCreated(msg: CrossChainTaskCreated): Buffer {
  const buffer = Buffer.alloc(256);
  let offset = 0;

  // Message type
  buffer.writeUInt8(CrossChainMessageType.TaskCreated, offset);
  offset += 1;

  // Version
  buffer.writeUInt8(msg.version, offset);
  offset += 1;

  // Source chain (u16 LE)
  buffer.writeUInt16LE(msg.sourceChain, offset);
  offset += 2;

  // Task ID (32 bytes)
  msg.taskId.copy(buffer, offset);
  offset += 32;

  // Creator (32 bytes)
  msg.creator.copy(buffer, offset);
  offset += 32;

  // Required capabilities (u64 LE)
  buffer.writeBigUInt64LE(msg.requiredCapabilities, offset);
  offset += 8;

  // Description hash (32 bytes)
  msg.descriptionHash.copy(buffer, offset);
  offset += 32;

  // Reward amount (u64 LE)
  buffer.writeBigUInt64LE(msg.rewardAmount, offset);
  offset += 8;

  // Deadline (i64 LE)
  buffer.writeBigInt64LE(msg.deadline, offset);
  offset += 8;

  // Task type (u8)
  buffer.writeUInt8(msg.taskType, offset);
  offset += 1;

  // Constraint hash (32 bytes)
  msg.constraintHash.copy(buffer, offset);
  offset += 32;

  // Max workers (u8)
  buffer.writeUInt8(msg.maxWorkers, offset);
  offset += 1;

  // Nonce (u64 LE)
  buffer.writeBigUInt64LE(msg.nonce, offset);
  offset += 8;

  // Created at (i64 LE)
  buffer.writeBigInt64LE(msg.createdAt, offset);
  offset += 8;

  return buffer.subarray(0, offset);
}

/**
 * Deserialize CrossChainTaskCreated from bytes
 */
export function deserializeTaskCreated(data: Buffer): CrossChainTaskCreated {
  let offset = 0;

  // Skip message type
  const messageType = data.readUInt8(offset);
  if (messageType !== CrossChainMessageType.TaskCreated) {
    throw new Error(`Invalid message type: expected ${CrossChainMessageType.TaskCreated}, got ${messageType}`);
  }
  offset += 1;

  const version = data.readUInt8(offset);
  offset += 1;

  const sourceChain = data.readUInt16LE(offset);
  offset += 2;

  const taskId = data.subarray(offset, offset + 32);
  offset += 32;

  const creator = data.subarray(offset, offset + 32);
  offset += 32;

  const requiredCapabilities = data.readBigUInt64LE(offset);
  offset += 8;

  const descriptionHash = data.subarray(offset, offset + 32);
  offset += 32;

  const rewardAmount = data.readBigUInt64LE(offset);
  offset += 8;

  const deadline = data.readBigInt64LE(offset);
  offset += 8;

  const taskType = data.readUInt8(offset);
  offset += 1;

  const constraintHash = data.subarray(offset, offset + 32);
  offset += 32;

  const maxWorkers = data.readUInt8(offset);
  offset += 1;

  const nonce = data.readBigUInt64LE(offset);
  offset += 8;

  const createdAt = data.readBigInt64LE(offset);
  offset += 8;

  return {
    version,
    sourceChain,
    taskId: Buffer.from(taskId),
    creator: Buffer.from(creator),
    requiredCapabilities,
    descriptionHash: Buffer.from(descriptionHash),
    rewardAmount,
    deadline,
    taskType,
    constraintHash: Buffer.from(constraintHash),
    maxWorkers,
    nonce,
    createdAt,
  };
}

/**
 * Serialize CrossChainTaskClaimed to bytes
 */
export function serializeTaskClaimed(msg: CrossChainTaskClaimed): Buffer {
  const buffer = Buffer.alloc(200);
  let offset = 0;

  buffer.writeUInt8(CrossChainMessageType.TaskClaimed, offset);
  offset += 1;

  buffer.writeUInt8(msg.version, offset);
  offset += 1;

  buffer.writeUInt16LE(msg.sourceChain, offset);
  offset += 2;

  buffer.writeUInt16LE(msg.workerChain, offset);
  offset += 2;

  msg.taskId.copy(buffer, offset);
  offset += 32;

  msg.worker.copy(buffer, offset);
  offset += 32;

  msg.workerAgentId.copy(buffer, offset);
  offset += 32;

  buffer.writeBigInt64LE(msg.expiresAt, offset);
  offset += 8;

  buffer.writeBigUInt64LE(msg.nonce, offset);
  offset += 8;

  buffer.writeBigInt64LE(msg.claimedAt, offset);
  offset += 8;

  return buffer.subarray(0, offset);
}

/**
 * Serialize CrossChainTaskCompleted to bytes
 */
export function serializeTaskCompleted(msg: CrossChainTaskCompleted): Buffer {
  const baseSize = 1 + 1 + 2 + 2 + 32 + 32 + 32 + 32 + 32 + 4 + 8 + 8;
  const buffer = Buffer.alloc(baseSize + msg.proofData.length);
  let offset = 0;

  buffer.writeUInt8(CrossChainMessageType.TaskCompleted, offset);
  offset += 1;

  buffer.writeUInt8(msg.version, offset);
  offset += 1;

  buffer.writeUInt16LE(msg.sourceChain, offset);
  offset += 2;

  buffer.writeUInt16LE(msg.workerChain, offset);
  offset += 2;

  msg.taskId.copy(buffer, offset);
  offset += 32;

  msg.worker.copy(buffer, offset);
  offset += 32;

  msg.proofBinding.copy(buffer, offset);
  offset += 32;

  msg.outputCommitment.copy(buffer, offset);
  offset += 32;

  msg.resultHash.copy(buffer, offset);
  offset += 32;

  // Proof data length (u32 LE)
  buffer.writeUInt32LE(msg.proofData.length, offset);
  offset += 4;

  // Proof data
  msg.proofData.copy(buffer, offset);
  offset += msg.proofData.length;

  buffer.writeBigInt64LE(msg.completedAt, offset);
  offset += 8;

  buffer.writeBigUInt64LE(msg.nonce, offset);
  offset += 8;

  return buffer.subarray(0, offset);
}

// ============================================================================
// PDA Derivation
// ============================================================================

/**
 * Derive cross-chain nonce tracker PDA
 */
export function deriveCrossChainNoncePda(
  sourceChain: number,
  taskId: Buffer,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const sourceChainBuffer = Buffer.alloc(2);
  sourceChainBuffer.writeUInt16LE(sourceChain);

  return PublicKey.findProgramAddressSync(
    [Buffer.from('xchain_nonce'), sourceChainBuffer, taskId],
    programId
  );
}

/**
 * Derive pending cross-chain claim PDA
 */
export function derivePendingClaimPda(
  sourceChain: number,
  taskId: Buffer,
  worker: Buffer,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  const sourceChainBuffer = Buffer.alloc(2);
  sourceChainBuffer.writeUInt16LE(sourceChain);

  return PublicKey.findProgramAddressSync(
    [Buffer.from('pending_claim'), sourceChainBuffer, taskId, worker],
    programId
  );
}

// ============================================================================
// Bridge Configuration
// ============================================================================

export interface BridgeConfig {
  /** Whether cross-chain is enabled */
  enabled: boolean;
  /** Minimum reward for cross-chain tasks */
  minCrossChainReward: bigint;
  /** Maximum message size in bytes */
  maxMessageSize: number;
  /** VAA expiration in seconds */
  vaaExpirationSeconds: number;
  /** Required confirmations before processing */
  requiredConfirmations: number;
  /** Wormhole core bridge address */
  wormholeBridge: PublicKey | null;
  /** Allowed destination chains */
  allowedChains: number[];
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  enabled: false,
  minCrossChainReward: 100_000_000n, // 0.1 SOL
  maxMessageSize: 1024,
  vaaExpirationSeconds: 86400,
  requiredConfirmations: 32,
  wormholeBridge: null,
  allowedChains: [],
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get chain name from chain ID
 */
export function getChainName(chainId: number): string {
  const chainNames: Record<number, string> = {
    [ChainId.SOLANA]: 'Solana',
    [ChainId.ETHEREUM]: 'Ethereum',
    [ChainId.POLYGON]: 'Polygon',
    [ChainId.AVALANCHE]: 'Avalanche',
    [ChainId.ARBITRUM]: 'Arbitrum',
    [ChainId.OPTIMISM]: 'Optimism',
    [ChainId.BASE]: 'Base',
    [ChainId.BSC]: 'BNB Chain',
    [ChainId.FANTOM]: 'Fantom',
    [ChainId.MOONBEAM]: 'Moonbeam',
    [ChainId.CELO]: 'Celo',
    [ChainId.SUI]: 'Sui',
    [ChainId.APTOS]: 'Aptos',
  };

  return chainNames[chainId] || `Chain ${chainId}`;
}

/**
 * Check if a chain is EVM-compatible
 */
export function isEvmChain(chainId: number): boolean {
  const evmChains: number[] = [
    ChainId.ETHEREUM,
    ChainId.POLYGON,
    ChainId.AVALANCHE,
    ChainId.ARBITRUM,
    ChainId.OPTIMISM,
    ChainId.BASE,
    ChainId.BSC,
    ChainId.FANTOM,
    ChainId.MOONBEAM,
    ChainId.CELO,
    ChainId.AURORA,
    ChainId.GNOSIS,
  ];

  return evmChains.includes(chainId);
}

/**
 * Pad an address to 32 bytes (for non-Solana addresses)
 */
export function padAddress(address: Buffer | Uint8Array): Buffer {
  const padded = Buffer.alloc(32);
  const addressBuf = Buffer.from(address);

  if (addressBuf.length > 32) {
    throw new Error('Address too long');
  }

  // Right-align the address (pad with zeros on the left)
  addressBuf.copy(padded, 32 - addressBuf.length);
  return padded;
}

/**
 * Convert Solana pubkey to 32-byte buffer
 */
export function pubkeyToBuffer(pubkey: PublicKey): Buffer {
  return Buffer.from(pubkey.toBytes());
}

/**
 * Generate a unique task ID for cross-chain tasks
 * Includes source chain ID to prevent collisions
 */
export function generateCrossChainTaskId(
  sourceChain: number,
  creator: PublicKey,
  nonce: bigint
): Buffer {
  const buffer = Buffer.alloc(32);

  // Chain ID (2 bytes)
  buffer.writeUInt16LE(sourceChain, 0);

  // Creator first 22 bytes
  creator.toBuffer().copy(buffer, 2, 0, 22);

  // Nonce (8 bytes)
  buffer.writeBigUInt64LE(nonce, 24);

  return buffer;
}
