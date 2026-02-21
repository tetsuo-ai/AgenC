/**
 * Ed25519 signing and verification for agent-to-agent messaging.
 *
 * Uses node:crypto with DER-encoded keys. Reuses the proven DER-encoding
 * pattern from gateway/identity.ts.
 *
 * @module
 */

import { sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import type { PublicKey, Keypair } from "@solana/web3.js";

// ============================================================================
// DER Prefix Constants
// ============================================================================

/** DER prefix for SPKI-encoded Ed25519 public key (32 raw bytes follow) */
const ED25519_DER_PUBLIC_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

/** DER prefix for PKCS8-encoded Ed25519 private key (32 raw bytes follow) */
const ED25519_DER_PRIVATE_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

// ============================================================================
// Signing Payload
// ============================================================================

/**
 * Build the canonical signing payload for a message.
 *
 * Layout: sender[32] | recipient[32] | nonce_u64_be[8] | content_utf8[...]
 */
export function buildSigningPayload(
  sender: PublicKey,
  recipient: PublicKey,
  nonce: number,
  content: string,
): Uint8Array {
  const contentBytes = new TextEncoder().encode(content);
  const payload = new Uint8Array(32 + 32 + 8 + contentBytes.length);

  // Sender (32 bytes)
  payload.set(sender.toBytes(), 0);

  // Recipient (32 bytes)
  payload.set(recipient.toBytes(), 32);

  // Nonce as big-endian u64 (8 bytes)
  const view = new DataView(payload.buffer, payload.byteOffset + 64, 8);
  view.setUint32(0, Math.floor(nonce / 0x100000000) >>> 0);
  view.setUint32(4, nonce >>> 0);

  // Content (variable length)
  payload.set(contentBytes, 72);

  return payload;
}

// ============================================================================
// Sign / Verify
// ============================================================================

/**
 * Sign a message payload with an Ed25519 keypair.
 *
 * Named `signAgentMessage` to avoid collision with wallet adapter `signMessage`.
 *
 * @param keypair - Solana keypair (first 32 bytes of secretKey = private key)
 * @param payload - The payload bytes to sign
 * @returns 64-byte Ed25519 signature
 */
export function signAgentMessage(
  keypair: Keypair,
  payload: Uint8Array,
): Uint8Array {
  const rawPrivate = keypair.secretKey.slice(0, 32);
  const derKey = createPrivateKey({
    key: Buffer.concat([ED25519_DER_PRIVATE_PREFIX, rawPrivate]),
    format: "der",
    type: "pkcs8",
  });
  const sig = sign(null, Buffer.from(payload), derKey);
  return new Uint8Array(sig);
}

/**
 * Verify an Ed25519 signature against a public key and payload.
 *
 * @param publicKey - Solana public key of the signer
 * @param payload - The original payload bytes
 * @param signature - The 64-byte Ed25519 signature
 * @returns true if the signature is valid
 */
export function verifyAgentSignature(
  publicKey: PublicKey,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const rawKey = publicKey.toBytes();
    const derKey = createPublicKey({
      key: Buffer.concat([ED25519_DER_PUBLIC_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload), derKey, Buffer.from(signature));
  } catch {
    return false;
  }
}
