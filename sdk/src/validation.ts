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
} from "./constants";

const MAX_MODEL_ID_LENGTH = 256;
const MAX_INPUT_DATA_SIZE = 1024 * 1024; // 1 MB

const MAX_INPUT_LENGTH = 512;
const DANGEROUS_CHARS = /[;&|`$(){}[\]<>!\\\x00\n\r]/;

function ensureReasonableInput(input: string, label: string): void {
  if (!input || input.trim().length === 0) {
    throw new Error(`Security: ${label} cannot be empty`);
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(
      `Security: ${label} exceeds maximum length (${MAX_INPUT_LENGTH} characters)`,
    );
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
  ensureReasonableInput(proverEndpoint, "Prover endpoint");

  let parsed: URL;
  try {
    parsed = new URL(proverEndpoint);
  } catch {
    throw new Error(`Security: Invalid prover endpoint URL: ${proverEndpoint}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "Security: Prover endpoint must use http or https protocol",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Security: Prover endpoint must not include credentials");
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
 * Validate inputs before computing a model commitment.
 *
 * Ensures `modelId` is a non-empty string within the allowed length and that
 * `weightsHash` is exactly {@link HASH_SIZE} bytes (32).
 */
export function validateModelCommitment(
  modelId: string,
  weightsHash: Uint8Array,
): void {
  if (!modelId || modelId.trim().length === 0) {
    throw new Error("Security: modelId cannot be empty");
  }
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    throw new Error(
      `Security: modelId exceeds maximum length (${MAX_MODEL_ID_LENGTH} characters)`,
    );
  }
  if (weightsHash.length !== HASH_SIZE) {
    throw new Error(
      `Security: weightsHash must be ${HASH_SIZE} bytes, got ${weightsHash.length}`,
    );
  }
}

/**
 * Validate inputs before computing an input commitment.
 *
 * Ensures `inputData` is non-empty and within the 1 MB size limit, and that
 * `salt` is a positive non-zero bigint (zero salt breaks commitment privacy).
 */
export function validateInputCommitment(
  inputData: Uint8Array,
  salt: bigint,
): void {
  if (inputData.length === 0) {
    throw new Error("Security: inputData cannot be empty");
  }
  if (inputData.length > MAX_INPUT_DATA_SIZE) {
    throw new Error(
      `Security: inputData exceeds maximum size (${MAX_INPUT_DATA_SIZE} bytes)`,
    );
  }
  if (salt <= 0n) {
    throw new Error(
      "Security: salt must be a positive non-zero bigint for input commitment privacy",
    );
  }
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
    throw new Error(
      `Security: sealBytes must be ${RISC0_SEAL_BORSH_LEN} bytes`,
    );
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
    throw new Error("Security: seal selector does not match trusted selector");
  }
}
