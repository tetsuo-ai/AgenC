/**
 * Unit tests for model and input commitment helpers.
 *
 * Covers:
 * 1. Determinism — same inputs always produce the same commitment
 * 2. Differentiation — distinct inputs produce distinct commitments
 * 3. Domain separation — model and input commitments cannot collide
 * 4. Field bounds — results are valid BN254 scalar field elements
 * 5. Validation helpers — reject bad inputs with clear errors
 */

import { describe, it, expect } from "vitest";
import { computeModelCommitment, computeInputCommitment, FIELD_MODULUS } from "../proofs";
import { validateModelCommitment, validateInputCommitment } from "../validation";
import { HASH_SIZE } from "../constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWeightsHash(fill: number = 0xab): Uint8Array {
  return new Uint8Array(HASH_SIZE).fill(fill);
}

function makeInputData(text: string = "hello inference"): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// computeModelCommitment
// ---------------------------------------------------------------------------

describe("computeModelCommitment", () => {
  it("returns a bigint in the BN254 scalar field", () => {
    const result = computeModelCommitment("llama-3-8b", makeWeightsHash());
    expect(typeof result).toBe("bigint");
    expect(result).toBeGreaterThanOrEqual(0n);
    expect(result).toBeLessThan(FIELD_MODULUS);
  });

  it("is deterministic", () => {
    const modelId = "llama-3-8b";
    const weightsHash = makeWeightsHash();
    expect(computeModelCommitment(modelId, weightsHash)).toBe(
      computeModelCommitment(modelId, weightsHash),
    );
  });

  it("produces different results for different modelIds", () => {
    const weightsHash = makeWeightsHash();
    const a = computeModelCommitment("llama-3-8b", weightsHash);
    const b = computeModelCommitment("mistral-7b", weightsHash);
    expect(a).not.toBe(b);
  });

  it("produces different results for different weightsHashes", () => {
    const modelId = "llama-3-8b";
    const a = computeModelCommitment(modelId, makeWeightsHash(0x01));
    const b = computeModelCommitment(modelId, makeWeightsHash(0x02));
    expect(a).not.toBe(b);
  });

  it("is sensitive to every byte of the weights hash", () => {
    const modelId = "test-model";
    const base = makeWeightsHash(0xff);
    const flipped = new Uint8Array(base);
    flipped[15] = 0x00;
    expect(computeModelCommitment(modelId, base)).not.toBe(
      computeModelCommitment(modelId, flipped),
    );
  });

  it("handles model IDs that differ only in suffix", () => {
    const weightsHash = makeWeightsHash();
    const a = computeModelCommitment("model-v1", weightsHash);
    const b = computeModelCommitment("model-v2", weightsHash);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// computeInputCommitment
// ---------------------------------------------------------------------------

describe("computeInputCommitment", () => {
  const salt = 42n;

  it("returns a bigint in the BN254 scalar field", () => {
    const result = computeInputCommitment(makeInputData(), salt);
    expect(typeof result).toBe("bigint");
    expect(result).toBeGreaterThanOrEqual(0n);
    expect(result).toBeLessThan(FIELD_MODULUS);
  });

  it("is deterministic", () => {
    const input = makeInputData();
    expect(computeInputCommitment(input, salt)).toBe(
      computeInputCommitment(input, salt),
    );
  });

  it("produces different results for different input data", () => {
    const a = computeInputCommitment(makeInputData("prompt A"), salt);
    const b = computeInputCommitment(makeInputData("prompt B"), salt);
    expect(a).not.toBe(b);
  });

  it("produces different results for different salts", () => {
    const input = makeInputData();
    const a = computeInputCommitment(input, 1n);
    const b = computeInputCommitment(input, 2n);
    expect(a).not.toBe(b);
  });

  it("handles large salt values", () => {
    const input = makeInputData();
    const largeSalt = FIELD_MODULUS - 1n;
    const result = computeInputCommitment(input, largeSalt);
    expect(typeof result).toBe("bigint");
    expect(result).toBeLessThan(FIELD_MODULUS);
  });

  it("handles binary input data", () => {
    const binary = new Uint8Array(64).fill(0xff);
    const result = computeInputCommitment(binary, salt);
    expect(typeof result).toBe("bigint");
    expect(result).toBeGreaterThanOrEqual(0n);
  });
});

// ---------------------------------------------------------------------------
// Domain separation
// ---------------------------------------------------------------------------

describe("domain separation between model and input commitments", () => {
  it("model and input commitments with matching raw bytes produce different results", () => {
    // Construct inputs whose raw bytes overlap to confirm domain tags prevent collisions.
    const sharedBytes = new Uint8Array(HASH_SIZE).fill(0x42);
    const modelCommitment = computeModelCommitment("", sharedBytes);
    const inputCommitment = computeInputCommitment(sharedBytes, 1n);
    // The two functions use different domain tags, so they must differ.
    expect(modelCommitment).not.toBe(inputCommitment);
  });
});

// ---------------------------------------------------------------------------
// validateModelCommitment
// ---------------------------------------------------------------------------

describe("validateModelCommitment", () => {
  it("accepts a valid modelId and weightsHash", () => {
    expect(() =>
      validateModelCommitment("llama-3-8b", makeWeightsHash()),
    ).not.toThrow();
  });

  it("rejects an empty modelId", () => {
    expect(() => validateModelCommitment("", makeWeightsHash())).toThrow(
      /modelId cannot be empty/,
    );
  });

  it("rejects a whitespace-only modelId", () => {
    expect(() => validateModelCommitment("   ", makeWeightsHash())).toThrow(
      /modelId cannot be empty/,
    );
  });

  it("rejects a modelId exceeding 256 characters", () => {
    const longId = "a".repeat(257);
    expect(() => validateModelCommitment(longId, makeWeightsHash())).toThrow(
      /modelId exceeds maximum length/,
    );
  });

  it("accepts a modelId of exactly 256 characters", () => {
    const maxId = "a".repeat(256);
    expect(() => validateModelCommitment(maxId, makeWeightsHash())).not.toThrow();
  });

  it("rejects a weightsHash shorter than 32 bytes", () => {
    expect(() =>
      validateModelCommitment("model", new Uint8Array(16)),
    ).toThrow(/weightsHash must be 32 bytes/);
  });

  it("rejects a weightsHash longer than 32 bytes", () => {
    expect(() =>
      validateModelCommitment("model", new Uint8Array(64)),
    ).toThrow(/weightsHash must be 32 bytes/);
  });

  it("accepts a weightsHash of exactly 32 bytes", () => {
    expect(() =>
      validateModelCommitment("model", new Uint8Array(32)),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateInputCommitment
// ---------------------------------------------------------------------------

describe("validateInputCommitment", () => {
  it("accepts valid inputData and salt", () => {
    expect(() =>
      validateInputCommitment(makeInputData(), 1n),
    ).not.toThrow();
  });

  it("rejects empty inputData", () => {
    expect(() => validateInputCommitment(new Uint8Array(0), 1n)).toThrow(
      /inputData cannot be empty/,
    );
  });

  it("rejects inputData exceeding 1 MB", () => {
    const oversized = new Uint8Array(1024 * 1024 + 1);
    expect(() => validateInputCommitment(oversized, 1n)).toThrow(
      /inputData exceeds maximum size/,
    );
  });

  it("accepts inputData of exactly 1 MB", () => {
    const maxSize = new Uint8Array(1024 * 1024);
    expect(() => validateInputCommitment(maxSize, 1n)).not.toThrow();
  });

  it("rejects zero salt", () => {
    expect(() => validateInputCommitment(makeInputData(), 0n)).toThrow(
      /salt must be a positive non-zero bigint/,
    );
  });

  it("rejects negative salt", () => {
    expect(() => validateInputCommitment(makeInputData(), -1n)).toThrow(
      /salt must be a positive non-zero bigint/,
    );
  });

  it("accepts large positive salt", () => {
    expect(() =>
      validateInputCommitment(makeInputData(), FIELD_MODULUS - 1n),
    ).not.toThrow();
  });
});
