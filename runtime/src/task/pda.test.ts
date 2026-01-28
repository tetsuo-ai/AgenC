import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import {
  deriveTaskPda,
  findTaskPda,
  deriveClaimPda,
  findClaimPda,
  deriveEscrowPda,
  findEscrowPda,
  TASK_ID_LENGTH,
  type PdaWithBump,
} from './pda.js';

/**
 * Creates a valid 32-byte task ID from a seed value.
 */
function createTaskId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

describe('Task PDA derivation helpers', () => {
  describe('deriveTaskPda', () => {
    it('derives deterministic PDA from creator + taskId', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(1);

      const result1 = deriveTaskPda(creator, taskId);
      const result2 = deriveTaskPda(creator, taskId);

      expect(result1.address.equals(result2.address)).toBe(true);
      expect(result1.bump).toBe(result2.bump);
    });

    it('different creator produces different PDA', () => {
      const creator1 = Keypair.generate().publicKey;
      const creator2 = Keypair.generate().publicKey;
      const taskId = createTaskId(1);

      const result1 = deriveTaskPda(creator1, taskId);
      const result2 = deriveTaskPda(creator2, taskId);

      expect(result1.address.equals(result2.address)).toBe(false);
    });

    it('different taskId produces different PDA', () => {
      const creator = Keypair.generate().publicKey;
      const taskId1 = createTaskId(1);
      const taskId2 = createTaskId(2);

      const result1 = deriveTaskPda(creator, taskId1);
      const result2 = deriveTaskPda(creator, taskId2);

      expect(result1.address.equals(result2.address)).toBe(false);
    });

    it('returns consistent bump', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(42);

      const result = deriveTaskPda(creator, taskId);

      expect(typeof result.bump).toBe('number');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);

      // Verify consistency
      const result2 = deriveTaskPda(creator, taskId);
      expect(result.bump).toBe(result2.bump);
    });

    it('uses default PROGRAM_ID when not specified', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(1);

      const result = deriveTaskPda(creator, taskId);

      // Verify by deriving with same seeds manually
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
        PROGRAM_ID,
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('uses custom programId when provided', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(2);
      const customProgramId = new PublicKey('11111111111111111111111111111111');

      const result = deriveTaskPda(creator, taskId, customProgramId);

      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
        customProgramId,
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('throws for taskId shorter than 32 bytes', () => {
      const creator = Keypair.generate().publicKey;
      const shortId = new Uint8Array(16);

      expect(() => deriveTaskPda(creator, shortId)).toThrow(
        `Invalid taskId length: 16 (must be ${TASK_ID_LENGTH})`,
      );
    });

    it('throws for taskId longer than 32 bytes', () => {
      const creator = Keypair.generate().publicKey;
      const longId = new Uint8Array(64);

      expect(() => deriveTaskPda(creator, longId)).toThrow(
        `Invalid taskId length: 64 (must be ${TASK_ID_LENGTH})`,
      );
    });

    it('throws for empty taskId', () => {
      const creator = Keypair.generate().publicKey;
      const emptyId = new Uint8Array(0);

      expect(() => deriveTaskPda(creator, emptyId)).toThrow(
        `Invalid taskId length: 0 (must be ${TASK_ID_LENGTH})`,
      );
    });
  });

  describe('deriveClaimPda', () => {
    it('derives deterministic PDA from taskPda + workerPda', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerPda = Keypair.generate().publicKey;

      const result1 = deriveClaimPda(taskPda, workerPda);
      const result2 = deriveClaimPda(taskPda, workerPda);

      expect(result1.address.equals(result2.address)).toBe(true);
      expect(result1.bump).toBe(result2.bump);
    });

    it('different worker produces different PDA', () => {
      const taskPda = Keypair.generate().publicKey;
      const worker1 = Keypair.generate().publicKey;
      const worker2 = Keypair.generate().publicKey;

      const result1 = deriveClaimPda(taskPda, worker1);
      const result2 = deriveClaimPda(taskPda, worker2);

      expect(result1.address.equals(result2.address)).toBe(false);
    });

    it('returns consistent bump', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerPda = Keypair.generate().publicKey;

      const result = deriveClaimPda(taskPda, workerPda);

      expect(typeof result.bump).toBe('number');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);
    });

    it('uses correct seeds', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerPda = Keypair.generate().publicKey;

      const result = deriveClaimPda(taskPda, workerPda);

      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.CLAIM, taskPda.toBuffer(), workerPda.toBuffer()],
        PROGRAM_ID,
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });
  });

  describe('deriveEscrowPda', () => {
    it('derives deterministic PDA from taskPda', () => {
      const taskPda = Keypair.generate().publicKey;

      const result1 = deriveEscrowPda(taskPda);
      const result2 = deriveEscrowPda(taskPda);

      expect(result1.address.equals(result2.address)).toBe(true);
      expect(result1.bump).toBe(result2.bump);
    });

    it('different taskPda produces different PDA', () => {
      const taskPda1 = Keypair.generate().publicKey;
      const taskPda2 = Keypair.generate().publicKey;

      const result1 = deriveEscrowPda(taskPda1);
      const result2 = deriveEscrowPda(taskPda2);

      expect(result1.address.equals(result2.address)).toBe(false);
    });

    it('returns consistent bump', () => {
      const taskPda = Keypair.generate().publicKey;

      const result = deriveEscrowPda(taskPda);

      expect(typeof result.bump).toBe('number');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);
    });

    it('uses correct seeds', () => {
      const taskPda = Keypair.generate().publicKey;

      const result = deriveEscrowPda(taskPda);

      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.ESCROW, taskPda.toBuffer()],
        PROGRAM_ID,
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });
  });

  describe('findTaskPda', () => {
    it('returns address only (no bump)', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(10);

      const address = findTaskPda(creator, taskId);

      expect(address).toBeInstanceOf(PublicKey);
    });

    it('matches deriveTaskPda().address', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(20);

      const address = findTaskPda(creator, taskId);
      const { address: derivedAddress } = deriveTaskPda(creator, taskId);

      expect(address.equals(derivedAddress)).toBe(true);
    });

    it('accepts custom programId', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(30);
      const customProgramId = new PublicKey('11111111111111111111111111111111');

      const address = findTaskPda(creator, taskId, customProgramId);
      const { address: derivedAddress } = deriveTaskPda(creator, taskId, customProgramId);

      expect(address.equals(derivedAddress)).toBe(true);
    });

    it('throws for invalid taskId length', () => {
      const creator = Keypair.generate().publicKey;
      const shortId = new Uint8Array(10);

      expect(() => findTaskPda(creator, shortId)).toThrow('Invalid taskId length');
    });
  });

  describe('findClaimPda', () => {
    it('returns address only (no bump)', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerPda = Keypair.generate().publicKey;

      const address = findClaimPda(taskPda, workerPda);

      expect(address).toBeInstanceOf(PublicKey);
    });

    it('matches deriveClaimPda().address', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerPda = Keypair.generate().publicKey;

      const address = findClaimPda(taskPda, workerPda);
      const { address: derivedAddress } = deriveClaimPda(taskPda, workerPda);

      expect(address.equals(derivedAddress)).toBe(true);
    });
  });

  describe('findEscrowPda', () => {
    it('returns address only (no bump)', () => {
      const taskPda = Keypair.generate().publicKey;

      const address = findEscrowPda(taskPda);

      expect(address).toBeInstanceOf(PublicKey);
    });

    it('matches deriveEscrowPda().address', () => {
      const taskPda = Keypair.generate().publicKey;

      const address = findEscrowPda(taskPda);
      const { address: derivedAddress } = deriveEscrowPda(taskPda);

      expect(address.equals(derivedAddress)).toBe(true);
    });
  });

  describe('PdaWithBump type', () => {
    it('satisfies interface contract', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = createTaskId(42);
      const pda: PdaWithBump = deriveTaskPda(creator, taskId);

      const _address: PublicKey = pda.address;
      const _bump: number = pda.bump;

      expect(_address).toBeInstanceOf(PublicKey);
      expect(typeof _bump).toBe('number');
    });
  });
});
