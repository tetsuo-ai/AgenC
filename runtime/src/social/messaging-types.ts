/**
 * Agent-to-agent messaging types, constants, and on-chain encoding helpers.
 *
 * On-chain messaging reuses the `update_state` instruction with a message-specific
 * state_key encoding. Off-chain messaging uses WebSocket with Ed25519 signatures.
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../idl.js';
import type { Logger } from '../utils/logger.js';
import type { ReputationSignalCallback } from './reputation-types.js';

// ============================================================================
// Constants
// ============================================================================

/** Magic prefix for message state_key — "msg\0" for memcmp filtering */
export const MSG_MAGIC = new Uint8Array([0x6d, 0x73, 0x67, 0x00]);

/** Maximum content size for on-chain messages (state_value is 64 bytes) */
export const MSG_CONTENT_MAX_ONCHAIN = 64;

// ============================================================================
// Core Types
// ============================================================================

/** Message delivery mode */
export type MessageMode = 'on-chain' | 'off-chain' | 'auto';

/** Core message object */
export interface AgentMessage {
  /** Derived from sender+nonce */
  id: string;
  /** Sender public key */
  sender: PublicKey;
  /** Recipient public key */
  recipient: PublicKey;
  /** UTF-8 text content */
  content: string;
  /** Delivery mode used */
  mode: MessageMode;
  /** Ed25519 signature bytes */
  signature: Uint8Array;
  /** Unix seconds */
  timestamp: number;
  /** Monotonic per-instance counter */
  nonce: number;
  /** Whether the message was sent on-chain */
  onChain: boolean;
}

/** Handler for incoming messages */
export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

/** Peer endpoint resolver (decoupled from AgentDiscovery #1097) */
export interface PeerResolver {
  resolveEndpoint(agentPubkey: PublicKey): Promise<string | null>;
}

/** Messaging configuration */
export interface MessagingConfig {
  /** Default delivery mode (default: 'auto') */
  defaultMode?: MessageMode;
  /** Max off-chain message size in bytes (default: 65536) */
  maxOffChainSize?: number;
  /** WebSocket connect timeout in ms (default: 5000) */
  connectTimeoutMs?: number;
  /** Off-chain delivery retry count (default: 3) */
  offChainRetries?: number;
  /** Off-chain listener port (default: 0 = random) */
  offChainPort?: number;
}

/** JSON wire format for off-chain WebSocket messages */
export interface OffChainEnvelope {
  type: 'message';
  sender: string;
  recipient: string;
  content: string;
  nonce: number;
  timestamp: number;
  /** Base64-encoded Ed25519 signature */
  signature: string;
}

/** Constructor config for AgentMessaging */
export interface MessagingOpsConfig {
  /** Anchor program instance (required) */
  program: Program<AgencCoordination>;
  /** 32-byte agent identifier */
  agentId: Uint8Array;
  /** Keypair for signing off-chain messages */
  wallet: Keypair;
  /** Optional peer endpoint resolver */
  discovery?: PeerResolver;
  /** Optional messaging configuration */
  config?: MessagingConfig;
  /** Optional logger */
  logger?: Logger;
  /** Optional callback for reputation-relevant signals (e.g. message sent) */
  onReputationSignal?: ReputationSignalCallback;
}

// ============================================================================
// On-Chain Encoding Helpers
// ============================================================================

/**
 * Encode a message state_key for the update_state instruction.
 *
 * Layout (32 bytes): magic(4) | recipient_prefix(20) | nonce_u64_be(8)
 *
 * The 20-byte recipient prefix (~160 bits) is effectively collision-free.
 */
export function encodeMessageStateKey(recipient: PublicKey, nonce: number): Uint8Array {
  const key = new Uint8Array(32);

  // Magic prefix (4 bytes)
  key.set(MSG_MAGIC, 0);

  // Recipient prefix (20 bytes)
  const recipientBytes = recipient.toBytes();
  key.set(recipientBytes.subarray(0, 20), 4);

  // Nonce as big-endian u64 (8 bytes)
  const view = new DataView(key.buffer, key.byteOffset + 24, 8);
  // Split nonce into high and low 32 bits for safe handling of large numbers
  view.setUint32(0, Math.floor(nonce / 0x100000000) >>> 0);
  view.setUint32(4, (nonce >>> 0));

  return key;
}

/**
 * Decode a message state_key.
 * Returns null if the magic prefix doesn't match.
 */
export function decodeMessageStateKey(
  stateKey: Uint8Array,
): { recipientPrefix: Uint8Array; nonce: number } | null {
  if (stateKey.length !== 32) return null;

  // Check magic
  for (let i = 0; i < MSG_MAGIC.length; i++) {
    if (stateKey[i] !== MSG_MAGIC[i]) return null;
  }

  const recipientPrefix = stateKey.slice(4, 24);

  const view = new DataView(stateKey.buffer, stateKey.byteOffset + 24, 8);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const nonce = high * 0x100000000 + low;

  return { recipientPrefix, nonce };
}

/**
 * Encode message content into a 64-byte state_value.
 * Content is UTF-8 encoded and zero-padded to 64 bytes.
 *
 * @throws Error if content exceeds 64 bytes when UTF-8 encoded
 * @throws Error if content is empty
 */
export function encodeMessageStateValue(content: string): Uint8Array {
  if (content.length === 0) {
    throw new Error('Message content cannot be empty');
  }

  const encoded = new TextEncoder().encode(content);
  if (encoded.length > MSG_CONTENT_MAX_ONCHAIN) {
    throw new Error(
      `Message content exceeds ${MSG_CONTENT_MAX_ONCHAIN} bytes: ${encoded.length} bytes`,
    );
  }

  const value = new Uint8Array(64);
  value.set(encoded, 0);
  return value;
}

/**
 * Decode a 64-byte state_value into message content string.
 * Trims trailing null padding.
 */
export function decodeMessageStateValue(stateValue: Uint8Array): string {
  // Find last non-zero byte
  let end = stateValue.length;
  while (end > 0 && stateValue[end - 1] === 0) {
    end--;
  }
  return new TextDecoder().decode(stateValue.subarray(0, end));
}
