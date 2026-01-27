import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,
} from './parse.js';

function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

describe('Event Parse Functions', () => {
  describe('parseTaskCreatedEvent', () => {
    it('should convert all fields correctly', () => {
      const raw = {
        taskId: Array.from({ length: 32 }, (_, i) => i),
        creator: new PublicKey('11111111111111111111111111111111'),
        requiredCapabilities: mockBN(7n),
        rewardAmount: mockBN(1_000_000_000n),
        taskType: 0,
        deadline: mockBN(1234567890),
        timestamp: mockBN(789012),
      };
      const parsed = parseTaskCreatedEvent(raw);
      expect(parsed.taskId).toBeInstanceOf(Uint8Array);
      expect(parsed.taskId.length).toBe(32);
      expect(parsed.requiredCapabilities).toBe(7n);
      expect(parsed.rewardAmount).toBe(1_000_000_000n);
      expect(parsed.taskType).toBe(0);
      expect(parsed.deadline).toBe(1234567890);
      expect(parsed.timestamp).toBe(789012);
    });

    it('should handle Uint8Array taskId input', () => {
      const taskId = new Uint8Array(32).fill(42);
      const raw = {
        taskId,
        creator: new PublicKey('11111111111111111111111111111111'),
        requiredCapabilities: mockBN(1n),
        rewardAmount: mockBN(500_000_000n),
        taskType: 1,
        deadline: mockBN(999999),
        timestamp: mockBN(111111),
      };
      const parsed = parseTaskCreatedEvent(raw);
      expect(parsed.taskId).toBe(taskId); // Same instance
    });
  });

  describe('parseTaskClaimedEvent', () => {
    it('should preserve u8 fields as numbers', () => {
      const workerKey = new PublicKey('11111111111111111111111111111111');
      const raw = {
        taskId: new Uint8Array(32),
        worker: workerKey,
        currentWorkers: 2,
        maxWorkers: 5,
        timestamp: mockBN(123456),
      };
      const parsed = parseTaskClaimedEvent(raw);
      expect(parsed.currentWorkers).toBe(2);
      expect(parsed.maxWorkers).toBe(5);
      expect(parsed.worker).toBe(workerKey);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe('parseTaskCompletedEvent', () => {
    it('should convert proofHash and rewardPaid', () => {
      const raw = {
        taskId: Array.from({ length: 32 }, (_, i) => i),
        worker: new PublicKey('11111111111111111111111111111111'),
        proofHash: Array.from({ length: 32 }, (_, i) => 255 - i),
        rewardPaid: mockBN(2_500_000_000n),
        timestamp: mockBN(789012),
      };
      const parsed = parseTaskCompletedEvent(raw);
      expect(parsed.proofHash).toBeInstanceOf(Uint8Array);
      expect(parsed.proofHash.length).toBe(32);
      expect(parsed.proofHash[0]).toBe(255);
      expect(parsed.rewardPaid).toBe(2_500_000_000n);
    });
  });

  describe('parseTaskCancelledEvent', () => {
    it('should convert refundAmount to bigint', () => {
      const raw = {
        taskId: new Uint8Array(32),
        creator: new PublicKey('11111111111111111111111111111111'),
        refundAmount: mockBN(1_500_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseTaskCancelledEvent(raw);
      expect(parsed.refundAmount).toBe(1_500_000_000n);
    });
  });

  describe('parseDisputeInitiatedEvent', () => {
    it('should convert both disputeId and taskId to Uint8Array', () => {
      const raw = {
        disputeId: Array.from({ length: 32 }, (_, i) => i),
        taskId: Array.from({ length: 32 }, (_, i) => 32 + i),
        initiator: new PublicKey('11111111111111111111111111111111'),
        resolutionType: 0,
        votingDeadline: mockBN(999999),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeInitiatedEvent(raw);
      expect(parsed.disputeId).toBeInstanceOf(Uint8Array);
      expect(parsed.taskId).toBeInstanceOf(Uint8Array);
      expect(parsed.disputeId[0]).toBe(0);
      expect(parsed.taskId[0]).toBe(32);
      expect(parsed.votingDeadline).toBe(999999);
    });
  });

  describe('parseDisputeVoteCastEvent', () => {
    it('should convert votesFor/votesAgainst to bigint and preserve boolean', () => {
      const raw = {
        disputeId: new Uint8Array(32),
        voter: new PublicKey('11111111111111111111111111111111'),
        approved: true,
        votesFor: mockBN(5n),
        votesAgainst: mockBN(2n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeVoteCastEvent(raw);
      expect(parsed.approved).toBe(true);
      expect(parsed.votesFor).toBe(5n);
      expect(parsed.votesAgainst).toBe(2n);
      expect(typeof parsed.votesFor).toBe('bigint');
      expect(typeof parsed.votesAgainst).toBe('bigint');
    });
  });

  describe('parseDisputeResolvedEvent', () => {
    it('should convert votesFor/votesAgainst to bigint', () => {
      const raw = {
        disputeId: new Uint8Array(32),
        resolutionType: 2,
        votesFor: mockBN(6n),
        votesAgainst: mockBN(1n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeResolvedEvent(raw);
      expect(parsed.resolutionType).toBe(2);
      expect(parsed.votesFor).toBe(6n);
      expect(parsed.votesAgainst).toBe(1n);
    });
  });

  describe('parseDisputeExpiredEvent', () => {
    it('should convert refundAmount to bigint', () => {
      const raw = {
        disputeId: new Uint8Array(32),
        taskId: new Uint8Array(32),
        refundAmount: mockBN(800_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeExpiredEvent(raw);
      expect(parsed.refundAmount).toBe(800_000_000n);
    });
  });

  describe('parseStateUpdatedEvent', () => {
    it('should convert stateKey to Uint8Array and version to bigint', () => {
      const raw = {
        stateKey: Array.from({ length: 32 }, (_, i) => i),
        updater: new PublicKey('11111111111111111111111111111111'),
        version: mockBN(42n),
        timestamp: mockBN(123456),
      };
      const parsed = parseStateUpdatedEvent(raw);
      expect(parsed.stateKey).toBeInstanceOf(Uint8Array);
      expect(parsed.stateKey.length).toBe(32);
      expect(parsed.version).toBe(42n);
    });
  });

  describe('parseProtocolInitializedEvent', () => {
    it('should preserve threshold and feeBps as numbers', () => {
      const raw = {
        authority: new PublicKey('11111111111111111111111111111111'),
        treasury: new PublicKey('11111111111111111111111111111112'),
        disputeThreshold: 66,
        protocolFeeBps: 250,
        timestamp: mockBN(123456),
      };
      const parsed = parseProtocolInitializedEvent(raw);
      expect(parsed.disputeThreshold).toBe(66);
      expect(parsed.protocolFeeBps).toBe(250);
    });
  });

  describe('parseRewardDistributedEvent', () => {
    it('should convert amount and protocolFee to bigint', () => {
      const raw = {
        taskId: new Uint8Array(32),
        recipient: new PublicKey('11111111111111111111111111111111'),
        amount: mockBN(1_000_000_000n),
        protocolFee: mockBN(25_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseRewardDistributedEvent(raw);
      expect(parsed.amount).toBe(1_000_000_000n);
      expect(parsed.protocolFee).toBe(25_000_000n);
    });
  });

  describe('parseRateLimitHitEvent', () => {
    it('should convert all fields correctly', () => {
      const raw = {
        agentId: new Uint8Array(32),
        actionType: 0,
        limitType: 1,
        currentCount: 10,
        maxCount: 20,
        cooldownRemaining: mockBN(3600),
        timestamp: mockBN(123456),
      };
      const parsed = parseRateLimitHitEvent(raw);
      expect(parsed.agentId).toBeInstanceOf(Uint8Array);
      expect(parsed.actionType).toBe(0);
      expect(parsed.limitType).toBe(1);
      expect(parsed.currentCount).toBe(10);
      expect(parsed.maxCount).toBe(20);
      expect(parsed.cooldownRemaining).toBe(3600);
      expect(typeof parsed.actionType).toBe('number');
      expect(typeof parsed.limitType).toBe('number');
    });
  });

  describe('parseMigrationCompletedEvent', () => {
    it('should preserve version numbers', () => {
      const raw = {
        fromVersion: 1,
        toVersion: 2,
        authority: new PublicKey('11111111111111111111111111111111'),
        timestamp: mockBN(123456),
      };
      const parsed = parseMigrationCompletedEvent(raw);
      expect(parsed.fromVersion).toBe(1);
      expect(parsed.toVersion).toBe(2);
    });
  });

  describe('parseProtocolVersionUpdatedEvent', () => {
    it('should preserve all version fields', () => {
      const raw = {
        oldVersion: 1,
        newVersion: 2,
        minSupportedVersion: 1,
        timestamp: mockBN(123456),
      };
      const parsed = parseProtocolVersionUpdatedEvent(raw);
      expect(parsed.oldVersion).toBe(1);
      expect(parsed.newVersion).toBe(2);
      expect(parsed.minSupportedVersion).toBe(1);
    });
  });
});
