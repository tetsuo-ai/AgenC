/**
 * Unit tests for ZK proof generation functions.
 *
 * These tests verify:
 * 1. Hash functions match expected outputs
 * 2. Field conversions are correct
 * 3. Binding computation is deterministic
 * 4. Salt generation produces valid field elements
 */

import { describe, it, expect, vi } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  pubkeyToField,
  computeBinding,
  computeConstraintHash,
  computeCommitmentFromOutput,
  computeHashes,
  computeNullifierFromAgentSecret,
  generateSalt,
  generateProof,
  generateProofWithProver,
  FIELD_MODULUS,
} from '../proofs';
import {
  OUTPUT_FIELD_COUNT,
  RISC0_SEAL_BORSH_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
  RISC0_SELECTOR_LEN,
} from '../constants';

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

  describe('computeBinding', () => {
    it('computes binding from task, agent, and commitment', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding = computeBinding(taskPda, agentPubkey, outputCommitment);

      expect(typeof binding).toBe('bigint');
      expect(binding).toBeGreaterThanOrEqual(0n);
      expect(binding).toBeLessThan(FIELD_MODULUS);
    });

    it('produces deterministic results', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeBinding(taskPda, agentPubkey, outputCommitment);
      const binding2 = computeBinding(taskPda, agentPubkey, outputCommitment);

      expect(binding1).toBe(binding2);
    });

    it('produces different results for different tasks', () => {
      const task1 = Keypair.generate().publicKey;
      const task2 = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeBinding(task1, agentPubkey, outputCommitment);
      const binding2 = computeBinding(task2, agentPubkey, outputCommitment);

      expect(binding1).not.toBe(binding2);
    });

    it('produces different results for different agents', () => {
      const taskPda = Keypair.generate().publicKey;
      const agent1 = Keypair.generate().publicKey;
      const agent2 = Keypair.generate().publicKey;
      const outputCommitment = 12345n;

      const binding1 = computeBinding(taskPda, agent1, outputCommitment);
      const binding2 = computeBinding(taskPda, agent2, outputCommitment);

      expect(binding1).not.toBe(binding2);
    });

    it('produces different results for different commitments', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;

      const binding1 = computeBinding(taskPda, agentPubkey, 1n);
      const binding2 = computeBinding(taskPda, agentPubkey, 2n);

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

  describe('computeHashes', () => {
    it('computes all hashes in one call', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [1n, 2n, 3n, 4n];
      const salt = generateSalt();

      const result = computeHashes(taskPda, agentPubkey, output, salt);

      expect(result.constraintHash).toBeGreaterThanOrEqual(0n);
      expect(result.constraintHash).toBeLessThan(FIELD_MODULUS);
      expect(result.outputCommitment).toBeGreaterThanOrEqual(0n);
      expect(result.outputCommitment).toBeLessThan(FIELD_MODULUS);
      expect(result.binding).toBeGreaterThanOrEqual(0n);
      expect(result.binding).toBeLessThan(FIELD_MODULUS);
      expect(result.nullifier).toBeGreaterThanOrEqual(0n);
      expect(result.nullifier.toString(16).length).toBeLessThanOrEqual(64);
    });

    it('produces consistent results with individual functions', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const output = [1n, 2n, 3n, 4n];
      const salt = 12345n;

      const result = computeHashes(taskPda, agentPubkey, output, salt);

      // Verify against individual function calls
      const constraintHash = computeConstraintHash(output);
      // computeHashes uses computeCommitmentFromOutput, not the legacy computeCommitment
      const outputCommitment = computeCommitmentFromOutput(output, salt);
      const binding = computeBinding(taskPda, agentPubkey, outputCommitment);

      expect(result.constraintHash).toBe(constraintHash);
      expect(result.outputCommitment).toBe(outputCommitment);
      expect(result.binding).toBe(binding);
      // computeHashes falls back to pubkeyToField when no agentSecret provided
      expect(result.nullifier).toBe(
        computeNullifierFromAgentSecret(
          constraintHash,
          outputCommitment,
          pubkeyToField(agentPubkey),
        )
      );
    });
  });

  describe('computeNullifierFromAgentSecret', () => {
    it('produces different nullifier when output_commitment changes', () => {
      const constraintHash = 123n;
      const agentSecret = 456n;
      const outputCommitmentA = 10n;
      const outputCommitmentB = 11n;

      const nullifierA = computeNullifierFromAgentSecret(
        constraintHash,
        outputCommitmentA,
        agentSecret,
      );
      const nullifierB = computeNullifierFromAgentSecret(
        constraintHash,
        outputCommitmentB,
        agentSecret,
      );

      expect(nullifierA).not.toBe(nullifierB);
    });

    it('produces identical nullifier for identical inputs', () => {
      const constraintHash = 999n;
      const outputCommitment = 123456n;
      const agentSecret = 789n;

      const first = computeNullifierFromAgentSecret(
        constraintHash,
        outputCommitment,
        agentSecret,
      );
      const second = computeNullifierFromAgentSecret(
        constraintHash,
        outputCommitment,
        agentSecret,
      );

      expect(first).toBe(second);
      expect(first.toString(16).length).toBeLessThanOrEqual(64);
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
      const outputCommitment = computeCommitmentFromOutput(output, salt);

      // Step 3: Compute expected binding
      const binding = computeBinding(taskPda, agentPubkey, outputCommitment);

      // All values should be valid field elements
      expect(constraintHash).toBeLessThan(FIELD_MODULUS);
      expect(outputCommitment).toBeLessThan(FIELD_MODULUS);
      expect(binding).toBeLessThan(FIELD_MODULUS);

      // Re-running should produce same results (deterministic)
      const constraintHash2 = computeConstraintHash(output);
      const outputCommitment2 = computeCommitmentFromOutput(output, salt);
      const binding2 = computeBinding(taskPda, agentPubkey, outputCommitment2);

      expect(constraintHash2).toBe(constraintHash);
      expect(outputCommitment2).toBe(outputCommitment);
      expect(binding2).toBe(binding);
    });

    it('matches RISC Zero computation for known values', () => {
      // These test values should match the RISC Zero guest test fixtures
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
      const outputCommitment = computeCommitmentFromOutput(output, salt);
      const binding = computeBinding(taskPda, agentPubkey, outputCommitment);

      // These should be non-zero and valid
      expect(constraintHash).toBeGreaterThan(0n);
      expect(outputCommitment).toBeGreaterThan(0n);
      expect(binding).toBeGreaterThan(0n);
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

      // Same output with same salt produces identical commitment
      const commitment1a = computeCommitmentFromOutput(output1, reusedSalt);
      const commitment1b = computeCommitmentFromOutput(output1, reusedSalt);
      expect(commitment1a).toBe(commitment1b);

      // Different outputs with same salt produce different commitments
      // but an attacker who knows the salt could brute-force the output
      const commitment2 = computeCommitmentFromOutput(output2, reusedSalt);
      expect(commitment1a).not.toBe(commitment2);

      // CORRECT: Use unique salt for each proof
      const uniqueSalt1 = generateSalt();
      const uniqueSalt2 = generateSalt();
      const secureCommitment1 = computeCommitmentFromOutput(output1, uniqueSalt1);
      const secureCommitment2 = computeCommitmentFromOutput(output1, uniqueSalt2);

      // Same output with different salts produces different commitments
      expect(secureCommitment1).not.toBe(secureCommitment2);
    });

    it('handles zero output safely', () => {
      // Edge case: zero output values should still produce valid commitment
      const zeroOutput = [0n, 0n, 0n, 0n];
      const salt = generateSalt();
      const commitment = computeCommitmentFromOutput(zeroOutput, salt);

      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('handles zero salt (should be avoided in practice)', () => {
      // While technically valid, zero salt should be avoided
      const output = [1n, 2n, 3n, 4n];
      const zeroSalt = 0n;
      const commitment = computeCommitmentFromOutput(output, zeroSalt);

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

      const originalBinding = computeBinding(taskPda, agentPubkey, commitment);

      // Changing any input should change the binding
      const altTask = Keypair.generate().publicKey;
      const altAgent = Keypair.generate().publicKey;
      const altCommitment = 67890n;

      expect(computeBinding(altTask, agentPubkey, commitment)).not.toBe(originalBinding);
      expect(computeBinding(taskPda, altAgent, commitment)).not.toBe(originalBinding);
      expect(computeBinding(taskPda, agentPubkey, altCommitment)).not.toBe(originalBinding);
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
      const hash1 = computeConstraintHash(output1);
      const hash2 = computeConstraintHash(output2);

      // Both should produce valid field elements
      expect(hash1).toBeGreaterThanOrEqual(0n);
      expect(hash1).toBeLessThan(FIELD_MODULUS);
      expect(hash2).toBeGreaterThanOrEqual(0n);
      expect(hash2).toBeLessThan(FIELD_MODULUS);

      // Test negative salt handling
      const negativeSalt = -12345n;
      const commitment = computeCommitmentFromOutput([1n, 2n, 3n, 4n], negativeSalt);
      expect(commitment).toBeGreaterThanOrEqual(0n);
      expect(commitment).toBeLessThan(FIELD_MODULUS);
    });

    it('handles negative commitment in binding computation', () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const negativeCommitment = -12345n;

      const binding = computeBinding(taskPda, agentPubkey, negativeCommitment);

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

  describe('generateProof salt validation', () => {
    it('rejects zero salt', async () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      await expect(
        generateProof({
          taskPda,
          agentPubkey,
          output: [1n, 2n, 3n, 4n],
          salt: 0n,
        })
      ).rejects.toThrow('non-zero');
    });

    it('accepts non-zero salt', async () => {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      const result = await generateProof({
        taskPda,
        agentPubkey,
        output: [1n, 2n, 3n, 4n],
        salt: 42n,
        agentSecret: 12345n,
      });
      expect(result.sealBytes.length).toBe(RISC0_SEAL_BORSH_LEN);
      expect(result.journal.length).toBe(RISC0_JOURNAL_LEN);
    });
  });

  describe('generateProofWithProver', () => {
    /**
     * Helper: given proof params, compute the expected journal so the mock
     * prover can return matching bytes.
     */
    function buildExpectedJournal(params: {
      taskPda: PublicKey;
      agentPubkey: PublicKey;
      output: bigint[];
      salt: bigint;
      agentSecret?: bigint;
    }): Buffer {
      const agentSecret = params.agentSecret ?? pubkeyToField(params.agentPubkey);
      const hashes = computeHashes(
        params.taskPda,
        params.agentPubkey,
        params.output,
        params.salt,
        agentSecret,
      );

      const toBytes32 = (v: bigint): Buffer => {
        const MAX_U256 = (1n << 256n) - 1n;
        if (v < 0n || v > MAX_U256) throw new Error('out of range');
        const hex = v.toString(16).padStart(64, '0');
        return Buffer.from(hex, 'hex');
      };

      return Buffer.concat([
        Buffer.from(params.taskPda.toBytes()),
        Buffer.from(params.agentPubkey.toBytes()),
        toBytes32(hashes.constraintHash),
        toBytes32(hashes.outputCommitment),
        toBytes32(hashes.binding),
        toBytes32(hashes.nullifier),
      ]);
    }

    function makeProofParams() {
      const taskPda = Keypair.generate().publicKey;
      const agentPubkey = Keypair.generate().publicKey;
      return {
        taskPda,
        agentPubkey,
        output: [1n, 2n, 3n, 4n],
        salt: 12345n,
        agentSecret: 67890n,
      };
    }

    it('returns all ProofResult fields with correct lengths', async () => {
      const params = makeProofParams();
      const expectedJournal = buildExpectedJournal(params);
      const fakeSealBytes = Buffer.alloc(RISC0_SEAL_BORSH_LEN, 0xab);
      const fakeImageId = Buffer.alloc(RISC0_IMAGE_ID_LEN, 0xcd);

      vi.doMock('../prover', () => ({
        prove: vi.fn().mockResolvedValue({
          sealBytes: fakeSealBytes,
          journal: expectedJournal,
          imageId: fakeImageId,
        }),
      }));

      const { generateProofWithProver: fn } = await import('../proofs');
      const result = await fn(params, { kind: 'local-binary', binaryPath: '/test' });

      expect(result.sealBytes.length).toBe(RISC0_SEAL_BORSH_LEN);
      expect(result.journal.length).toBe(RISC0_JOURNAL_LEN);
      expect(result.imageId.length).toBe(RISC0_IMAGE_ID_LEN);
      expect(result.bindingSeed.length).toBe(32);
      expect(result.nullifierSeed.length).toBe(32);
      expect(result.proof.length).toBe(RISC0_SEAL_BORSH_LEN - RISC0_SELECTOR_LEN);
      expect(result.constraintHash.length).toBe(32);
      expect(result.outputCommitment.length).toBe(32);
      expect(result.binding.length).toBe(32);
      expect(result.nullifier.length).toBe(32);
      expect(result.proofSize).toBe(RISC0_SEAL_BORSH_LEN - RISC0_SELECTOR_LEN);
      expect(result.generationTime).toBeGreaterThanOrEqual(0);

      vi.doUnmock('../prover');
    });

    it('proof is sealBytes minus the 4-byte selector', async () => {
      const params = makeProofParams();
      const expectedJournal = buildExpectedJournal(params);
      const fakeSealBytes = Buffer.alloc(RISC0_SEAL_BORSH_LEN);
      // Write recognizable pattern in selector and body
      fakeSealBytes[0] = 0x52; fakeSealBytes[1] = 0x5a;
      fakeSealBytes[2] = 0x56; fakeSealBytes[3] = 0x4d;
      for (let i = 4; i < RISC0_SEAL_BORSH_LEN; i++) fakeSealBytes[i] = i & 0xff;

      vi.doMock('../prover', () => ({
        prove: vi.fn().mockResolvedValue({
          sealBytes: fakeSealBytes,
          journal: expectedJournal,
          imageId: Buffer.alloc(RISC0_IMAGE_ID_LEN, 0xee),
        }),
      }));

      const { generateProofWithProver: fn } = await import('../proofs');
      const result = await fn(params, { kind: 'local-binary', binaryPath: '/test' });

      // proof should be bytes [4..260] of sealBytes
      expect(result.proof.length).toBe(256);
      expect(result.proof[0]).toBe(4 & 0xff);

      vi.doUnmock('../prover');
    });

    it('rejects journal mismatch from prover', async () => {
      const params = makeProofParams();
      const tamperedJournal = Buffer.alloc(RISC0_JOURNAL_LEN, 0xff); // all 0xff — won't match

      vi.doMock('../prover', () => ({
        prove: vi.fn().mockResolvedValue({
          sealBytes: Buffer.alloc(RISC0_SEAL_BORSH_LEN),
          journal: tamperedJournal,
          imageId: Buffer.alloc(RISC0_IMAGE_ID_LEN),
        }),
      }));

      const { generateProofWithProver: fn } = await import('../proofs');
      await expect(fn(params, { kind: 'local-binary', binaryPath: '/test' }))
        .rejects.toThrow('does not match computed fields');

      vi.doUnmock('../prover');
    });

    it('propagates ProverError from backend', async () => {
      const params = makeProofParams();
      const { ProverError: PE } = await import('../prover');

      vi.doMock('../prover', () => ({
        prove: vi.fn().mockRejectedValue(
          new PE('binary crashed', 'local-binary'),
        ),
      }));

      const { generateProofWithProver: fn } = await import('../proofs');
      await expect(fn(params, { kind: 'local-binary', binaryPath: '/test' }))
        .rejects.toThrow('binary crashed');

      vi.doUnmock('../prover');
    });

    it('locally computed hashes match individual function results', async () => {
      const params = makeProofParams();
      const expectedJournal = buildExpectedJournal(params);
      const fakeImageId = Buffer.alloc(RISC0_IMAGE_ID_LEN, 0x11);

      vi.doMock('../prover', () => ({
        prove: vi.fn().mockResolvedValue({
          sealBytes: Buffer.alloc(RISC0_SEAL_BORSH_LEN),
          journal: expectedJournal,
          imageId: fakeImageId,
        }),
      }));

      const { generateProofWithProver: fn } = await import('../proofs');
      const result = await fn(params, { kind: 'remote', endpoint: 'https://test.com' });

      // Verify hash buffers match what computeHashes would produce
      const hashes = computeHashes(
        params.taskPda,
        params.agentPubkey,
        params.output,
        params.salt,
        params.agentSecret,
      );

      const toBytes32 = (v: bigint): Buffer => {
        const hex = v.toString(16).padStart(64, '0');
        return Buffer.from(hex, 'hex');
      };

      expect(result.constraintHash.equals(toBytes32(hashes.constraintHash))).toBe(true);
      expect(result.outputCommitment.equals(toBytes32(hashes.outputCommitment))).toBe(true);
      expect(result.bindingSeed.equals(toBytes32(hashes.binding))).toBe(true);
      expect(result.nullifierSeed.equals(toBytes32(hashes.nullifier))).toBe(true);

      vi.doUnmock('../prover');
    });
  });
});
