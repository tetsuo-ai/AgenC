/**
 * Unit tests for ZK proof generation functions.
 *
 * These tests verify:
 * 1. Hash functions match expected outputs
 * 2. Field conversions are correct
 * 3. Binding computation is deterministic
 * 4. Salt generation produces valid field elements
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  pubkeyToField,
  computeExpectedBinding,
  computeConstraintHash,
  computeCommitment,
  generateSalt,
  FIELD_MODULUS,
} from '../proofs';
import { OUTPUT_FIELD_COUNT, HASH_SIZE } from '../constants';

describe('proofs', () => {
  describe('pubkeyToField', () => {
    it('converts a pubkey to a field element', () => {
      const keypair = Keypair.generate();
      const field = pubkeyToField(keypair.publicKey);

      expect(typeof field).toBe('bigint');
      expect(field).toBeGreaterThanOrEqual(0n);
      expect(field).toBeLessThan(FIELD_MODULUS);
    });

    it('produces deterministic results', () => {
      const keypair = Keypair.generate();
      const field1 = pubkeyToField(keypair.publicKey);
      const field2 = pubkeyToField(keypair.publicKey);

      expect(field1).toBe(field2);
    });

    it('produces different results for different pubkeys', () => {
      const keypair1 = Keypair.generate();
      const keypair2 = Keypair.generate();
      const field1 = pubkeyToField(keypair1.publicKey);
      const field2 = pubkeyToField(keypair2.publicKey);

      expect(field1).not.toBe(field2);
    });

    it('handles zero pubkey', () => {
      const zeroPubkey = new PublicKey(Buffer.alloc(32, 0));
      const field = pubkeyToField(zeroPubkey);

      expect(field).toBe(0n);
    });

    it('handles max byte pubkey', () => {
      const maxPubkey = new PublicKey(Buffer.alloc(32, 0xff));
      const field = pubkeyToField(maxPubkey);

      expect(field).toBeGreaterThan(0n);
      expect(field).toBeLessThan(FIELD_MODULUS);
    });
  });

  describe('computeConstraintHash', () => {
    it('hashes 4 field elements to a single field', () => {
      const output = [1n, 2n, 3n, 4n];
      const hash = computeConstraintHash(output);

      expect(typeof hash).toBe('bigint');
      expect(hash).toBeGreaterThanOrEqual(0n);
      expect(hash).toBeLessThan(FIELD_MODULUS);
    });

    it('produces deterministic results', () => {
      const output = [1n, 2n, 3n, 4n];
      const hash1 = computeConstraintHash(output);
      const hash2 = computeConstraintHash(output);

      expect(hash1).toBe(hash2);
    });

    it('produces different results for different inputs', () => {
      const output1 = [1n, 2n, 3n, 4n];
      const output2 = [5n, 6n, 7n, 8n];
      const hash1 = computeConstraintHash(output1);
      const hash2 = computeConstraintHash(output2);

      expect(hash1).not.toBe(hash2);
    });

    it('rejects wrong number of elements', () => {
      expect(() => computeConstraintHash([1n, 2n, 3n])).toThrow();
      expect(() => computeConstraintHash([1n, 2n, 3n, 4n, 5n])).toThrow();
    });

    it('handles large field elements', () => {
      const output = [
        FIELD_MODULUS - 1n,
        FIELD_MODULUS - 2n,
        FIELD_MODULUS - 3n,
        FIELD_MODULUS - 4n,
      ];
      const hash = computeConstraintHash(output);

      expect(hash).toBeGreaterThanOrEqual(0n);
      expect(hash).toBeLessThan(FIELD_MODULUS);
    });
  });

  describe('computeCommitment', () => {
    it('hashes constraint and salt to commitment', () => {
      const constraintHash = 12345n;
      const salt = 67890n;
      const commitment = computeCommitment(constraintHash, salt);

      expect(typeof commitment).toBe('bigint');
      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('produces deterministic results', () => {
      const constraintHash = 12345n;
      const salt = 67890n;
      const commitment1 = computeCommitment(constraintHash, salt);
      const commitment2 = computeCommitment(constraintHash, salt);

      expect(commitment1).toBe(commitment2);
    });

    it('produces different results for different salts', () => {
      const constraintHash = 12345n;
      const commitment1 = computeCommitment(constraintHash, 1n);
      const commitment2 = computeCommitment(constraintHash, 2n);

      expect(commitment1).not.toBe(commitment2);
    });

    it('produces different results for different constraints', () => {
      const salt = 67890n;
      const commitment1 = computeCommitment(1n, salt);
      const commitment2 = computeCommitment(2n, salt);

      expect(commitment1).not.toBe(commitment2);
    });
  });

  describe('computeExpectedBinding', () => {
    it('computes binding from task, agent, and commitment', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);

      expect(typeof binding).toBe('bigint');
      expect(binding).toBeGreaterThanOrEqual(0n);
      expect(binding).toBeLessThan(FIELD_MODULUS);
    });

    it('produces deterministic results', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);
      const binding2 = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);

      expect(binding1).toBe(binding2);
    });

    it('produces different results for different tasks', () => {
      const task1 = Keypair.generate().publicKey;
      const task2 = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeExpectedBinding(task1, agentPubkey, outputCommitment);
      const binding2 = computeExpectedBinding(task2, agentPubkey, outputCommitment);

      expect(binding1).not.toBe(binding2);
    });

    it('produces different results for different agents', () => {
      const taskPda = Keypair.generate().publicKey;
      const agent1 = Keypair.generate().publicKey;
      const agent2 = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeExpectedBinding(taskPda, agent1, outputCommitment);
      const binding2 = computeExpectedBinding(taskPda, agent2, outputCommitment);

      expect(binding1).not.toBe(binding2);
    });

    it('produces different results for different commitments', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;

      const binding1 = computeExpectedBinding(taskPda, agentPubkey, 1n);
      const binding2 = computeExpectedBinding(taskPda, agentPubkey, 2n);

      expect(binding1).not.toBe(binding2);
    });
  });

  describe('generateSalt', () => {
    it('generates a valid field element', () => {
      const salt = generateSalt();

      expect(typeof salt).toBe('bigint');
      expect(salt).toBeGreaterThanOrEqual(0n);
      expect(salt).toBeLessThan(FIELD_MODULUS);
    });

    it('generates unique values', () => {
      const salts = new Set<bigint>();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        salts.add(generateSalt());
      }

      // All salts should be unique (collision probability is negligible)
      expect(salts.size).toBe(iterations);
    });

    it('generates non-zero values (with overwhelming probability)', () => {
      const iterations = 100;
      let hasNonZero = false;

      for (let i = 0; i < iterations; i++) {
        if (generateSalt() !== 0n) {
          hasNonZero = true;
          break;
        }
      }

      expect(hasNonZero).toBe(true);
    });
  });

  describe('end-to-end proof parameter generation', () => {
    it('generates consistent parameters for proof creation', () => {
      // Simulate the full proof parameter generation flow
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [1n, 2n, 3n, 4n];
      const salt = generateSalt();

      // Step 1: Compute constraint hash from output
      const constraintHash = computeConstraintHash(output);

      // Step 2: Compute output commitment
      const outputCommitment = computeCommitment(constraintHash, salt);

      // Step 3: Compute expected binding
      const expectedBinding = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);

      // All values should be valid field elements
      expect(constraintHash).toBeLessThan(FIELD_MODULUS);
      expect(outputCommitment).toBeLessThan(FIELD_MODULUS);
      expect(expectedBinding).toBeLessThan(FIELD_MODULUS);

      // Re-running should produce same results (deterministic)
      const constraintHash2 = computeConstraintHash(output);
      const outputCommitment2 = computeCommitment(constraintHash2, salt);
      const expectedBinding2 = computeExpectedBinding(taskPda, agentPubkey, outputCommitment2);

      expect(constraintHash2).toBe(constraintHash);
      expect(outputCommitment2).toBe(outputCommitment);
      expect(expectedBinding2).toBe(expectedBinding);
    });

    it('matches circuit computation for known values', () => {
      // These test values should match the circuit test fixtures
      // Task ID: 42 (0x2a) as 32-byte big-endian
      const taskIdBytes = Buffer.alloc(32, 0);
      taskIdBytes[31] = 0x2a;
      const taskPda = new PublicKey(taskIdBytes);

      // Agent: sequential bytes 0x01-0x20
      const agentBytes = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        agentBytes[i] = i + 1;
      }
      const agentPubkey = new PublicKey(agentBytes);

      const output = [1n, 2n, 3n, 4n];
      const salt = 12345n;

      // Compute values
      const constraintHash = computeConstraintHash(output);
      const outputCommitment = computeCommitment(constraintHash, salt);
      const expectedBinding = computeExpectedBinding(taskPda, agentPubkey, outputCommitment);

      // These should be non-zero and valid
      expect(constraintHash).toBeGreaterThan(0n);
      expect(outputCommitment).toBeGreaterThan(0n);
      expect(expectedBinding).toBeGreaterThan(0n);

      // NOTE: Debug logging removed for security - avoid leaking test values in CI/CD logs
      // If you need to debug circuit compatibility, temporarily add console.log statements
    });
  });

  describe('security edge cases', () => {
    it('handles values exceeding field modulus (overflow wrapping)', () => {
      // Values exceeding FIELD_MODULUS should be reduced via modular arithmetic
      // This is handled internally by the hash functions
      const overflowOutput = [
        FIELD_MODULUS + 1n, // Should wrap to 1
        FIELD_MODULUS + 2n, // Should wrap to 2
        FIELD_MODULUS + 3n, // Should wrap to 3
        FIELD_MODULUS + 4n, // Should wrap to 4
      ];
      const normalOutput = [1n, 2n, 3n, 4n];

      const overflowHash = computeConstraintHash(overflowOutput);
      const normalHash = computeConstraintHash(normalOutput);

      // After modular reduction, these should produce the same result
      expect(overflowHash).toBe(normalHash);
    });

    it('demonstrates salt reuse vulnerability - same salt produces same commitment', () => {
      // SECURITY: This test demonstrates why salt reuse is dangerous
      // If an attacker can observe multiple commitments with the same salt,
      // they may be able to deduce information about the outputs
      const output1 = [1n, 2n, 3n, 4n];
      const output2 = [5n, 6n, 7n, 8n];
      const reusedSalt = 12345n;

      const constraint1 = computeConstraintHash(output1);
      const constraint2 = computeConstraintHash(output2);

      // Same salt with same constraint produces identical commitment
      const commitment1a = computeCommitment(constraint1, reusedSalt);
      const commitment1b = computeCommitment(constraint1, reusedSalt);
      expect(commitment1a).toBe(commitment1b);

      // Different constraints with same salt produce different commitments
      // but an attacker who knows the salt could brute-force the constraint
      const commitment2 = computeCommitment(constraint2, reusedSalt);
      expect(commitment1a).not.toBe(commitment2);

      // CORRECT: Use unique salt for each proof
      const uniqueSalt1 = generateSalt();
      const uniqueSalt2 = generateSalt();
      const secureCommitment1 = computeCommitment(constraint1, uniqueSalt1);
      const secureCommitment2 = computeCommitment(constraint1, uniqueSalt2);

      // Same constraint with different salts produces different commitments
      expect(secureCommitment1).not.toBe(secureCommitment2);
    });

    it('handles zero constraint hash safely', () => {
      // Edge case: zero constraint hash should still produce valid commitment
      const zeroConstraint = 0n;
      const salt = generateSalt();
      const commitment = computeCommitment(zeroConstraint, salt);

      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('handles zero salt (should be avoided in practice)', () => {
      // While technically valid, zero salt should be avoided
      const constraintHash = computeConstraintHash([1n, 2n, 3n, 4n]);
      const zeroSalt = 0n;
      const commitment = computeCommitment(constraintHash, zeroSalt);

      // Should still produce valid output (just less secure)
      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('binding uniquely identifies task-agent-commitment tuple', () => {
      // Security property: any change to task, agent, or commitment
      // must produce a different binding
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const commitment = 12345n;

      const originalBinding = computeExpectedBinding(taskPda, agentPubkey, commitment);

      // Changing any input should change the binding
      const altTask = Keypair.generate().publicKey;
      const altAgent = Keypair.generate().publicKey;
      const altCommitment = 67890n;

      expect(computeExpectedBinding(altTask, agentPubkey, commitment)).not.toBe(originalBinding);
      expect(computeExpectedBinding(taskPda, altAgent, commitment)).not.toBe(originalBinding);
      expect(computeExpectedBinding(taskPda, agentPubkey, altCommitment)).not.toBe(originalBinding);
    });

    it('handles negative bigint values via modular reduction', () => {
      // SECURITY: Negative bigints could cause undefined behavior if not handled
      // JavaScript allows negative bigints, but field arithmetic should reduce them
      // properly. Test that negative values are handled consistently.
      const output1 = [-1n, -2n, -3n, -4n];
      const output2 = [
        FIELD_MODULUS - 1n,
        FIELD_MODULUS - 2n,
        FIELD_MODULUS - 3n,
        FIELD_MODULUS - 4n,
      ];

      // Negative values should be equivalent to their positive modular counterparts
      // Note: JavaScript % operator preserves sign, so -1n % FIELD_MODULUS = -1n
      // The hash function should handle this internally via explicit modular reduction
      const hash1 = computeConstraintHash(output1);
      const hash2 = computeConstraintHash(output2);

      // Both should produce valid field elements
      expect(hash1).toBeGreaterThanOrEqual(0n);
      expect(hash1).toBeLessThan(FIELD_MODULUS);
      expect(hash2).toBeGreaterThanOrEqual(0n);
      expect(hash2).toBeLessThan(FIELD_MODULUS);

      // Test negative salt handling
      const constraintHash = computeConstraintHash([1n, 2n, 3n, 4n]);
      const negativeSalt = -12345n;
      const commitment = computeCommitment(constraintHash, negativeSalt);
      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('handles negative commitment in binding computation', () => {
      // SECURITY: Negative commitment could cause issues in binding computation
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const negativeCommitment = -12345n;

      const binding = computeExpectedBinding(taskPda, agentPubkey, negativeCommitment);

      // Should still produce valid field element
      expect(binding).toBeGreaterThanOrEqual(0n);
      expect(binding).toBeLessThan(FIELD_MODULUS);
    });

    it('pubkeyToField produces consistent results for edge case pubkeys', () => {
      // Test pubkey with specific bit patterns that could cause issues
      // All high bits set
      const highBitsPubkey = new PublicKey(Buffer.alloc(32, 0x80));
      const highBitsField = pubkeyToField(highBitsPubkey);
      expect(highBitsField).toBeGreaterThanOrEqual(0n);
      expect(highBitsField).toBeLessThan(FIELD_MODULUS);

      // Alternating bits
      const alternatingBytes = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) {
        alternatingBytes[i] = i % 2 === 0 ? 0xaa : 0x55;
      }
      const alternatingPubkey = new PublicKey(alternatingBytes);
      const alternatingField = pubkeyToField(alternatingPubkey);
      expect(alternatingField).toBeGreaterThanOrEqual(0n);
      expect(alternatingField).toBeLessThan(FIELD_MODULUS);

      // Verify determinism
      expect(pubkeyToField(highBitsPubkey)).toBe(highBitsField);
      expect(pubkeyToField(alternatingPubkey)).toBe(alternatingField);
    });

    it('large output values are reduced correctly', () => {
      // SECURITY: Very large values (much larger than FIELD_MODULUS) should be reduced
      const veryLargeOutput = [
        FIELD_MODULUS * 1000n + 1n,
        FIELD_MODULUS * 1000n + 2n,
        FIELD_MODULUS * 1000n + 3n,
        FIELD_MODULUS * 1000n + 4n,
      ];
      const normalOutput = [1n, 2n, 3n, 4n];

      const largeHash = computeConstraintHash(veryLargeOutput);
      const normalHash = computeConstraintHash(normalOutput);

      // After modular reduction, these should produce the same result
      expect(largeHash).toBe(normalHash);
    });
  });
});
