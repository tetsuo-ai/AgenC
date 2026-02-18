/**
 * Security validation utilities for AgenC SDK.
 */

import {
  HASH_SIZE,
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  RISC0_SELECTOR_LEN,
  TRUSTED_RISC0_SELECTOR,
} from './constants';
import * as path from 'path';

const MAX_INPUT_LENGTH = 512;
const DANGEROUS_CHARS = /[;&|`$(){}[\]<>!\\]/;

function ensureReasonableInput(input: string, label: string): void {
  if (!input || input.trim().length === 0) {
    throw new Error(`Security: ${label} cannot be empty`);
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(`Security: ${label} exceeds maximum length (${MAX_INPUT_LENGTH} characters)`);
  }
  if (DANGEROUS_CHARS.test(input)) {
    throw new Error(`Security: ${label} contains disallowed characters`);
  }
}

/**
 * Validate an optional RISC0 prover endpoint URL.
 *
 * Accepts only HTTP(S) URLs and rejects inline credentials.
 */
export function validateProverEndpoint(proverEndpoint: string): void {
  ensureReasonableInput(proverEndpoint, 'Prover endpoint');

  let parsed: URL;
  try {
    parsed = new URL(proverEndpoint);
  } catch {
    throw new Error(`Security: Invalid prover endpoint URL: ${proverEndpoint}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Security: Prover endpoint must use http or https protocol');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Security: Prover endpoint must not include credentials');
  }
}

export interface Risc0PayloadLike {
  sealBytes: Uint8Array | Buffer;
  journal: Uint8Array | Buffer;
  imageId: Uint8Array | Buffer;
  bindingSeed: Uint8Array | Buffer;
  nullifierSeed: Uint8Array | Buffer;
}

/**
 * Validate local shape constraints for RISC0 private proof payloads.
 */
export function validateRisc0PayloadShape(payload: Risc0PayloadLike): void {
  const sealBytes = Buffer.from(payload.sealBytes);
  const journal = Buffer.from(payload.journal);
  const imageId = Buffer.from(payload.imageId);
  const bindingSeed = Buffer.from(payload.bindingSeed);
  const nullifierSeed = Buffer.from(payload.nullifierSeed);

  if (sealBytes.length !== RISC0_SEAL_BORSH_LEN) {
    throw new Error(`Security: sealBytes must be ${RISC0_SEAL_BORSH_LEN} bytes`);
  }
  if (journal.length !== RISC0_JOURNAL_LEN) {
    throw new Error(`Security: journal must be ${RISC0_JOURNAL_LEN} bytes`);
  }
  if (imageId.length !== RISC0_IMAGE_ID_LEN) {
    throw new Error(`Security: imageId must be ${RISC0_IMAGE_ID_LEN} bytes`);
  }
  if (bindingSeed.length !== HASH_SIZE) {
    throw new Error(`Security: bindingSeed must be ${HASH_SIZE} bytes`);
  }
  if (nullifierSeed.length !== HASH_SIZE) {
    throw new Error(`Security: nullifierSeed must be ${HASH_SIZE} bytes`);
  }

  const selector = sealBytes.subarray(0, RISC0_SELECTOR_LEN);
  if (!selector.equals(Buffer.from(TRUSTED_RISC0_SELECTOR))) {
    throw new Error('Security: seal selector does not match trusted selector');
  }
}

/**
 * @deprecated Circuit-path validation is removed from the RISC0 SDK flow.
 * Kept temporarily for compatibility with legacy internal modules.
 */
export function validateCircuitPath(_circuitPath: string): void {
  ensureReasonableInput(_circuitPath, 'Circuit path');

  if (path.isAbsolute(_circuitPath)) {
    throw new Error('Security: Absolute circuit paths are not allowed');
  }

  const normalized = path.normalize(_circuitPath);
  if (normalized.startsWith('..') || normalized.includes('../') || normalized.includes('..\\')) {
    throw new Error('Security: Path traversal in circuit path is not allowed');
  }
}
