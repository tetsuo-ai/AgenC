/**
 * Tests for CommitmentLedger
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CommitmentLedger,
  CommitmentStatus,
  SpeculativeCommitment,
  CommitmentLedgerConfig,
} from './commitment-ledger.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Generates a random PublicKey for testing.
 */
function randomPda(): PublicKey {
  return Keypair.generate().publicKey;
}

/**
 * Generates a random 32-byte task ID.
 */
function randomTaskId(): Uint8Array {
  const id = new Uint8Array(32);
  crypto.getRandomValues(id);
  return id;
}

/**
 * Generates a random 32-byte hash.
 */
function randomHash(): Uint8Array {
  const hash = new Uint8Array(32);
  crypto.getRandomValues(hash);
  return hash;
}

/**
 * Creates a commitment with default test values.
 */
function createTestCommitment(
  ledger: CommitmentLedger,
  overrides?: {
    taskPda?: PublicKey;
    taskId?: Uint8Array;
    resultHash?: Uint8Array;
    producerAgent?: PublicKey;
    stakeAtRisk?: bigint;
  }
): SpeculativeCommitment {
  return ledger.createCommitment(
    overrides?.taskPda ?? randomPda(),
    overrides?.taskId ?? randomTaskId(),
    overrides?.resultHash ?? randomHash(),
    overrides?.producerAgent ?? randomPda(),
    overrides?.stakeAtRisk ?? 1000000n
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('CommitmentLedger', () => {
  let ledger: CommitmentLedger;

  beforeEach(() => {
    ledger = new CommitmentLedger();
  });

  describe('createCommitment', () => {
    it('should create a commitment with correct properties', () => {
      const taskPda = randomPda();
      const taskId = randomTaskId();
      const resultHash = randomHash();
      const producerAgent = randomPda();
      const stakeAtRisk = 5000000n;

      const commitment = ledger.createCommitment(
        taskPda,
        taskId,
        resultHash,
        producerAgent,
        stakeAtRisk
      );

      expect(commitment.id).toBeDefined();
      expect(commitment.id.length).toBe(32); // 16 bytes as hex
      expect(commitment.sourceTaskPda.equals(taskPda)).toBe(true);
      expect(commitment.sourceTaskId).toEqual(taskId);
      expect(commitment.resultHash).toEqual(resultHash);
      expect(commitment.producerAgent.equals(producerAgent)).toBe(true);
      expect(commitment.stakeAtRisk).toBe(stakeAtRisk);
      expect(commitment.status).toBe('pending');
      expect(commitment.dependentTaskPdas).toEqual([]);
      expect(commitment.createdAt).toBeLessThanOrEqual(Date.now());
      expect(commitment.confirmedAt).toBeNull();
      expect(commitment.depth).toBe(0);
    });

    it('should reject duplicate commitments for the same task', () => {
      const taskPda = randomPda();

      createTestCommitment(ledger, { taskPda });

      expect(() => createTestCommitment(ledger, { taskPda })).toThrow(
        'Commitment already exists'
      );
    });

    it('should enforce maxCommitments limit', () => {
      const smallLedger = new CommitmentLedger({ maxCommitments: 3 });

      createTestCommitment(smallLedger);
      createTestCommitment(smallLedger);
      createTestCommitment(smallLedger);

      expect(() => createTestCommitment(smallLedger)).toThrow(
        'Maximum commitments limit'
      );
    });

    it('should generate unique IDs for each commitment', () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const commitment = createTestCommitment(ledger);
        expect(ids.has(commitment.id)).toBe(false);
        ids.add(commitment.id);
      }
    });
  });

  describe('getByTask', () => {
    it('should retrieve a commitment by task PDA', () => {
      const taskPda = randomPda();
      const created = createTestCommitment(ledger, { taskPda });

      const retrieved = ledger.getByTask(taskPda);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent task', () => {
      const result = ledger.getByTask(randomPda());
      expect(result).toBeUndefined();
    });
  });

  describe('getById', () => {
    it('should retrieve a commitment by ID', () => {
      const created = createTestCommitment(ledger);

      const retrieved = ledger.getById(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent ID', () => {
      const result = ledger.getById('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('should update commitment status', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      ledger.updateStatus(taskPda, 'executing');

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.status).toBe('executing');
    });

    it('should allow all valid status transitions', () => {
      const statuses: CommitmentStatus[] = [
        'pending',
        'executing',
        'executed',
        'proof_generating',
        'proof_generated',
        'confirmed',
        'failed',
        'rolled_back',
      ];

      for (const status of statuses) {
        const taskPda = randomPda();
        createTestCommitment(ledger, { taskPda });

        ledger.updateStatus(taskPda, status);

        const commitment = ledger.getByTask(taskPda);
        expect(commitment?.status).toBe(status);
      }
    });

    it('should throw error for non-existent task', () => {
      expect(() => ledger.updateStatus(randomPda(), 'executing')).toThrow(
        'Commitment not found'
      );
    });
  });

  describe('addDependent', () => {
    it('should add a dependent task', () => {
      const taskPda = randomPda();
      const dependentPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      ledger.addDependent(taskPda, dependentPda);

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.dependentTaskPdas.length).toBe(1);
      expect(commitment?.dependentTaskPdas[0].equals(dependentPda)).toBe(true);
    });

    it('should handle multiple dependents', () => {
      const taskPda = randomPda();
      const dependent1 = randomPda();
      const dependent2 = randomPda();
      const dependent3 = randomPda();
      createTestCommitment(ledger, { taskPda });

      ledger.addDependent(taskPda, dependent1);
      ledger.addDependent(taskPda, dependent2);
      ledger.addDependent(taskPda, dependent3);

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.dependentTaskPdas.length).toBe(3);
    });

    it('should not add duplicate dependents', () => {
      const taskPda = randomPda();
      const dependentPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      ledger.addDependent(taskPda, dependentPda);
      ledger.addDependent(taskPda, dependentPda);

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.dependentTaskPdas.length).toBe(1);
    });

    it('should throw error for non-existent task', () => {
      expect(() => ledger.addDependent(randomPda(), randomPda())).toThrow(
        'Commitment not found'
      );
    });
  });

  describe('markConfirmed', () => {
    it('should mark commitment as confirmed with timestamp', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      const beforeConfirm = Date.now();
      ledger.markConfirmed(taskPda);
      const afterConfirm = Date.now();

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.status).toBe('confirmed');
      expect(commitment?.confirmedAt).toBeGreaterThanOrEqual(beforeConfirm);
      expect(commitment?.confirmedAt).toBeLessThanOrEqual(afterConfirm);
    });

    it('should throw error for non-existent task', () => {
      expect(() => ledger.markConfirmed(randomPda())).toThrow(
        'Commitment not found'
      );
    });
  });

  describe('markFailed', () => {
    it('should mark commitment as failed', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      const affected = ledger.markFailed(taskPda);

      const commitment = ledger.getByTask(taskPda);
      expect(commitment?.status).toBe('failed');
      expect(affected.length).toBe(1);
      expect(affected[0].id).toBe(commitment?.id);
    });

    it('should cascade to dependent commitments', () => {
      // Create a chain: parent -> child -> grandchild
      const parentPda = randomPda();
      const childPda = randomPda();
      const grandchildPda = randomPda();

      const parent = createTestCommitment(ledger, { taskPda: parentPda });
      const child = createTestCommitment(ledger, { taskPda: childPda });
      const grandchild = createTestCommitment(ledger, {
        taskPda: grandchildPda,
      });

      // Set up dependencies
      ledger.addDependent(parentPda, childPda);
      ledger.addDependent(childPda, grandchildPda);

      // Fail the parent
      const affected = ledger.markFailed(parentPda);

      expect(affected.length).toBe(3);
      expect(ledger.getByTask(parentPda)?.status).toBe('failed');
      expect(ledger.getByTask(childPda)?.status).toBe('rolled_back');
      expect(ledger.getByTask(grandchildPda)?.status).toBe('rolled_back');
    });

    it('should throw error for non-existent task', () => {
      expect(() => ledger.markFailed(randomPda())).toThrow(
        'Commitment not found'
      );
    });
  });

  describe('getAffectedByFailure', () => {
    it('should return empty array for non-existent task', () => {
      const affected = ledger.getAffectedByFailure(randomPda());
      expect(affected).toEqual([]);
    });

    it('should return only the task if no dependents', () => {
      const taskPda = randomPda();
      const commitment = createTestCommitment(ledger, { taskPda });

      const affected = ledger.getAffectedByFailure(taskPda);

      expect(affected.length).toBe(1);
      expect(affected[0].id).toBe(commitment.id);
    });

    it('should return all transitive dependents', () => {
      // Create a tree structure:
      //       root
      //      /    \
      //   child1  child2
      //     |
      //  grandchild
      const rootPda = randomPda();
      const child1Pda = randomPda();
      const child2Pda = randomPda();
      const grandchildPda = randomPda();

      createTestCommitment(ledger, { taskPda: rootPda });
      createTestCommitment(ledger, { taskPda: child1Pda });
      createTestCommitment(ledger, { taskPda: child2Pda });
      createTestCommitment(ledger, { taskPda: grandchildPda });

      ledger.addDependent(rootPda, child1Pda);
      ledger.addDependent(rootPda, child2Pda);
      ledger.addDependent(child1Pda, grandchildPda);

      const affected = ledger.getAffectedByFailure(rootPda);

      expect(affected.length).toBe(4);
    });

    it('should handle diamond dependencies', () => {
      // Create a diamond:
      //     root
      //    /    \
      //  mid1   mid2
      //    \    /
      //    bottom
      const rootPda = randomPda();
      const mid1Pda = randomPda();
      const mid2Pda = randomPda();
      const bottomPda = randomPda();

      createTestCommitment(ledger, { taskPda: rootPda });
      createTestCommitment(ledger, { taskPda: mid1Pda });
      createTestCommitment(ledger, { taskPda: mid2Pda });
      createTestCommitment(ledger, { taskPda: bottomPda });

      ledger.addDependent(rootPda, mid1Pda);
      ledger.addDependent(rootPda, mid2Pda);
      ledger.addDependent(mid1Pda, bottomPda);
      ledger.addDependent(mid2Pda, bottomPda);

      const affected = ledger.getAffectedByFailure(rootPda);

      // Should include all 4 nodes, each only once
      expect(affected.length).toBe(4);
      const ids = new Set(affected.map((c) => c.id));
      expect(ids.size).toBe(4);
    });
  });

  describe('getTotalStakeAtRisk', () => {
    it('should return 0 for empty ledger', () => {
      expect(ledger.getTotalStakeAtRisk()).toBe(0n);
    });

    it('should sum stake from active commitments', () => {
      createTestCommitment(ledger, { stakeAtRisk: 1000n });
      createTestCommitment(ledger, { stakeAtRisk: 2000n });
      createTestCommitment(ledger, { stakeAtRisk: 3000n });

      expect(ledger.getTotalStakeAtRisk()).toBe(6000n);
    });

    it('should exclude confirmed commitments', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda, stakeAtRisk: 1000n });
      createTestCommitment(ledger, { stakeAtRisk: 2000n });

      ledger.markConfirmed(taskPda);

      expect(ledger.getTotalStakeAtRisk()).toBe(2000n);
    });

    it('should exclude failed commitments', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda, stakeAtRisk: 1000n });
      createTestCommitment(ledger, { stakeAtRisk: 2000n });

      ledger.markFailed(taskPda);

      expect(ledger.getTotalStakeAtRisk()).toBe(2000n);
    });

    it('should exclude rolled back commitments', () => {
      const parentPda = randomPda();
      const childPda = randomPda();
      createTestCommitment(ledger, { taskPda: parentPda, stakeAtRisk: 1000n });
      createTestCommitment(ledger, { taskPda: childPda, stakeAtRisk: 2000n });
      createTestCommitment(ledger, { stakeAtRisk: 3000n });

      ledger.addDependent(parentPda, childPda);
      ledger.markFailed(parentPda);

      expect(ledger.getTotalStakeAtRisk()).toBe(3000n);
    });
  });

  describe('getMaxDepth', () => {
    it('should return 0 for empty ledger', () => {
      expect(ledger.getMaxDepth()).toBe(0);
    });

    it('should return max depth of active commitments', () => {
      // All depth 0 by default in this implementation
      createTestCommitment(ledger);
      createTestCommitment(ledger);

      expect(ledger.getMaxDepth()).toBe(0);
    });

    it('should exclude confirmed commitments from max depth', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });
      createTestCommitment(ledger);

      ledger.markConfirmed(taskPda);

      expect(ledger.getMaxDepth()).toBe(0);
    });
  });

  describe('getByDepth', () => {
    it('should return empty array for non-existent depth', () => {
      const result = ledger.getByDepth(5);
      expect(result).toEqual([]);
    });

    it('should return commitments at specified depth', () => {
      const c1 = createTestCommitment(ledger);
      const c2 = createTestCommitment(ledger);

      const result = ledger.getByDepth(0);

      expect(result.length).toBe(2);
      const ids = new Set(result.map((c) => c.id));
      expect(ids.has(c1.id)).toBe(true);
      expect(ids.has(c2.id)).toBe(true);
    });
  });

  describe('pruneConfirmed', () => {
    it('should return 0 for empty ledger', () => {
      expect(ledger.pruneConfirmed()).toBe(0);
    });

    it('should not prune recently confirmed commitments', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });
      ledger.markConfirmed(taskPda);

      const pruned = ledger.pruneConfirmed();

      expect(pruned).toBe(0);
      expect(ledger.getByTask(taskPda)).toBeDefined();
    });

    it('should prune old confirmed commitments', () => {
      // Use a ledger with very short retention
      const shortRetentionLedger = new CommitmentLedger({
        confirmedRetentionMs: 1, // 1ms retention
      });

      const taskPda = randomPda();
      createTestCommitment(shortRetentionLedger, { taskPda });
      shortRetentionLedger.markConfirmed(taskPda);

      // Wait a bit to ensure expiration
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Busy wait for 10ms
      }

      const pruned = shortRetentionLedger.pruneConfirmed();

      expect(pruned).toBe(1);
      expect(shortRetentionLedger.getByTask(taskPda)).toBeUndefined();
    });

    it('should not prune non-confirmed commitments', () => {
      const shortRetentionLedger = new CommitmentLedger({
        confirmedRetentionMs: 1,
      });

      createTestCommitment(shortRetentionLedger);
      createTestCommitment(shortRetentionLedger);

      // Wait for potential expiration
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Busy wait
      }

      const pruned = shortRetentionLedger.pruneConfirmed();

      expect(pruned).toBe(0);
    });

    it('should clean up all indexes when pruning', () => {
      const shortRetentionLedger = new CommitmentLedger({
        confirmedRetentionMs: 1,
      });

      const taskPda = randomPda();
      createTestCommitment(shortRetentionLedger, { taskPda });
      shortRetentionLedger.markConfirmed(taskPda);

      const start = Date.now();
      while (Date.now() - start < 10) {
        // Busy wait
      }

      shortRetentionLedger.pruneConfirmed();

      expect(shortRetentionLedger.getByTask(taskPda)).toBeUndefined();
      expect(shortRetentionLedger.getByDepth(0).length).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return zeros for empty ledger', () => {
      const stats = ledger.getStats();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.executing).toBe(0);
      expect(stats.executed).toBe(0);
      expect(stats.proofGenerating).toBe(0);
      expect(stats.proofGenerated).toBe(0);
      expect(stats.confirmed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.rolledBack).toBe(0);
      expect(stats.totalStakeAtRisk).toBe(0n);
      expect(stats.maxDepth).toBe(0);
    });

    it('should count commitments by status', () => {
      const pda1 = randomPda();
      const pda2 = randomPda();
      const pda3 = randomPda();
      const pda4 = randomPda();

      createTestCommitment(ledger, { taskPda: pda1 });
      createTestCommitment(ledger, { taskPda: pda2 });
      createTestCommitment(ledger, { taskPda: pda3 });
      createTestCommitment(ledger, { taskPda: pda4 });

      ledger.updateStatus(pda2, 'executing');
      ledger.markConfirmed(pda3);
      ledger.markFailed(pda4);

      const stats = ledger.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(1);
      expect(stats.executing).toBe(1);
      expect(stats.confirmed).toBe(1);
      expect(stats.failed).toBe(1);
    });

    it('should calculate total stake at risk', () => {
      createTestCommitment(ledger, { stakeAtRisk: 1000n });
      createTestCommitment(ledger, { stakeAtRisk: 2000n });

      const stats = ledger.getStats();

      expect(stats.totalStakeAtRisk).toBe(3000n);
    });
  });

  describe('mutation queue', () => {
    it('should queue and process mutations', () => {
      const taskPda = randomPda();
      const commitment = createTestCommitment(ledger, { taskPda });

      // Queue a status update
      ledger.queueMutation({
        type: 'updateStatus',
        taskPda,
        status: 'executing',
      });

      // Status should not change until processed
      expect(ledger.getByTask(taskPda)?.status).toBe('pending');

      // Process mutations
      ledger.processMutations();

      // Now status should be updated
      expect(ledger.getByTask(taskPda)?.status).toBe('executing');
    });

    it('should process multiple mutations in order', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      ledger.queueMutation({
        type: 'updateStatus',
        taskPda,
        status: 'executing',
      });
      ledger.queueMutation({
        type: 'updateStatus',
        taskPda,
        status: 'executed',
      });
      ledger.queueMutation({
        type: 'updateStatus',
        taskPda,
        status: 'proof_generating',
      });

      ledger.processMutations();

      expect(ledger.getByTask(taskPda)?.status).toBe('proof_generating');
    });
  });

  describe('clear', () => {
    it('should remove all commitments', () => {
      createTestCommitment(ledger);
      createTestCommitment(ledger);
      createTestCommitment(ledger);

      ledger.clear();

      expect(ledger.getAllCommitments().length).toBe(0);
      expect(ledger.getStats().total).toBe(0);
    });
  });

  describe('getAllCommitments', () => {
    it('should return all commitments', () => {
      const c1 = createTestCommitment(ledger);
      const c2 = createTestCommitment(ledger);
      const c3 = createTestCommitment(ledger);

      const all = ledger.getAllCommitments();

      expect(all.length).toBe(3);
      const ids = new Set(all.map((c) => c.id));
      expect(ids.has(c1.id)).toBe(true);
      expect(ids.has(c2.id)).toBe(true);
      expect(ids.has(c3.id)).toBe(true);
    });
  });

  describe('persistence', () => {
    let persistPath: string;

    beforeEach(() => {
      persistPath = join(tmpdir(), `commitment-ledger-test-${Date.now()}.json`);
    });

    afterEach(async () => {
      try {
        await fs.unlink(persistPath);
      } catch {
        // Ignore if file doesn't exist
      }
    });

    it('should throw error when persistence is disabled', async () => {
      const nonPersistentLedger = new CommitmentLedger({
        persistToDisk: false,
      });

      await expect(nonPersistentLedger.persist()).rejects.toThrow(
        'persistence is not enabled'
      );
      await expect(nonPersistentLedger.load()).rejects.toThrow(
        'persistence is not enabled'
      );
    });

    it('should throw error when path is not configured', async () => {
      const missingPathLedger = new CommitmentLedger({
        persistToDisk: true,
        // No persistPath
      });

      await expect(missingPathLedger.persist()).rejects.toThrow(
        'path is not configured'
      );
      await expect(missingPathLedger.load()).rejects.toThrow(
        'path is not configured'
      );
    });

    it('should persist and load commitments', async () => {
      const persistentLedger = new CommitmentLedger({
        persistToDisk: true,
        persistPath,
      });

      // Create some commitments
      const taskPda1 = randomPda();
      const taskPda2 = randomPda();
      const taskId1 = randomTaskId();
      const taskId2 = randomTaskId();
      const resultHash1 = randomHash();
      const resultHash2 = randomHash();
      const producer1 = randomPda();
      const producer2 = randomPda();

      const c1 = persistentLedger.createCommitment(
        taskPda1,
        taskId1,
        resultHash1,
        producer1,
        1000n
      );
      const c2 = persistentLedger.createCommitment(
        taskPda2,
        taskId2,
        resultHash2,
        producer2,
        2000n
      );

      // Add a dependent
      persistentLedger.addDependent(taskPda1, taskPda2);

      // Update status
      persistentLedger.updateStatus(taskPda1, 'executing');
      persistentLedger.markConfirmed(taskPda2);

      // Persist
      await persistentLedger.persist();

      // Create a new ledger and load
      const loadedLedger = new CommitmentLedger({
        persistToDisk: true,
        persistPath,
      });
      await loadedLedger.load();

      // Verify loaded data
      const loaded1 = loadedLedger.getByTask(taskPda1);
      const loaded2 = loadedLedger.getByTask(taskPda2);

      expect(loaded1).toBeDefined();
      expect(loaded1?.id).toBe(c1.id);
      expect(loaded1?.status).toBe('executing');
      expect(loaded1?.stakeAtRisk).toBe(1000n);
      expect(loaded1?.sourceTaskPda.equals(taskPda1)).toBe(true);
      expect(loaded1?.dependentTaskPdas.length).toBe(1);
      expect(loaded1?.dependentTaskPdas[0].equals(taskPda2)).toBe(true);

      expect(loaded2).toBeDefined();
      expect(loaded2?.id).toBe(c2.id);
      expect(loaded2?.status).toBe('confirmed');
      expect(loaded2?.confirmedAt).toBeDefined();
    });

    it('should handle loading from non-existent file', async () => {
      const newLedger = new CommitmentLedger({
        persistToDisk: true,
        persistPath: join(tmpdir(), `nonexistent-${Date.now()}.json`),
      });

      // Should not throw, just start with empty state
      await newLedger.load();

      expect(newLedger.getAllCommitments().length).toBe(0);
    });

    it('should preserve byte arrays correctly', async () => {
      const persistentLedger = new CommitmentLedger({
        persistToDisk: true,
        persistPath,
      });

      const taskId = randomTaskId();
      const resultHash = randomHash();
      const taskPda = randomPda();

      persistentLedger.createCommitment(
        taskPda,
        taskId,
        resultHash,
        randomPda(),
        1000n
      );

      await persistentLedger.persist();

      const loadedLedger = new CommitmentLedger({
        persistToDisk: true,
        persistPath,
      });
      await loadedLedger.load();

      const loaded = loadedLedger.getByTask(taskPda);

      expect(loaded?.sourceTaskId).toEqual(taskId);
      expect(loaded?.resultHash).toEqual(resultHash);
    });
  });

  describe('edge cases', () => {
    it('should handle very large stake values', () => {
      const largeStake = 1000000000000000000n; // 1e18

      const commitment = createTestCommitment(ledger, {
        stakeAtRisk: largeStake,
      });

      expect(commitment.stakeAtRisk).toBe(largeStake);
      expect(ledger.getTotalStakeAtRisk()).toBe(largeStake);
    });

    it('should handle zero stake', () => {
      const commitment = createTestCommitment(ledger, { stakeAtRisk: 0n });

      expect(commitment.stakeAtRisk).toBe(0n);
      expect(ledger.getTotalStakeAtRisk()).toBe(0n);
    });

    it('should handle commitment with no dependents marked as failed', () => {
      const taskPda = randomPda();
      createTestCommitment(ledger, { taskPda });

      const affected = ledger.markFailed(taskPda);

      expect(affected.length).toBe(1);
    });

    it('should handle long dependency chains', () => {
      const pdas: PublicKey[] = [];
      for (let i = 0; i < 100; i++) {
        const pda = randomPda();
        pdas.push(pda);
        createTestCommitment(ledger, { taskPda: pda });

        if (i > 0) {
          ledger.addDependent(pdas[i - 1], pda);
        }
      }

      // Fail the root
      const affected = ledger.markFailed(pdas[0]);

      expect(affected.length).toBe(100);
    });
  });
});
