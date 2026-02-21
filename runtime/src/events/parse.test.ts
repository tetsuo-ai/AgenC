import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  parseTaskCreatedEvent,
  parseTaskClaimedEvent,
  parseTaskCompletedEvent,
  parseTaskCancelledEvent,
  parseDisputeInitiatedEvent,
  parseDisputeVoteCastEvent,
  parseDisputeResolvedEvent,
  parseDisputeExpiredEvent,
  parseDisputeCancelledEvent,
  parseArbiterVotesCleanedUpEvent,
  parseStateUpdatedEvent,
  parseProtocolInitializedEvent,
  parseRewardDistributedEvent,
  parseRateLimitHitEvent,
  parseMigrationCompletedEvent,
  parseProtocolVersionUpdatedEvent,
  parseRateLimitsUpdatedEvent,
  parseProtocolFeeUpdatedEvent,
  parseReputationChangedEvent,
  parseBondDepositedEvent,
  parseBondLockedEvent,
  parseBondReleasedEvent,
  parseBondSlashedEvent,
  parseSpeculativeCommitmentCreatedEvent,
  parseDependentTaskCreatedEvent,
} from "./parse.js";

function mockBN(value: bigint | number): {
  toNumber: () => number;
  toString: () => string;
} {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

const TEST_KEY = new PublicKey("11111111111111111111111111111111");

function createId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

describe("Event Parse Functions", () => {
  describe("parseTaskCreatedEvent", () => {
    it("should convert all fields correctly", () => {
      const raw = {
        taskId: Array.from({ length: 32 }, (_, i) => i),
        creator: new PublicKey("11111111111111111111111111111111"),
        requiredCapabilities: mockBN(7n),
        rewardAmount: mockBN(1_000_000_000n),
        taskType: 0,
        deadline: mockBN(1234567890),
        minReputation: 10,
        rewardMint: TEST_KEY,
        timestamp: mockBN(789012),
      };
      const parsed = parseTaskCreatedEvent(raw);
      expect(parsed.taskId).toBeInstanceOf(Uint8Array);
      expect(parsed.taskId.length).toBe(32);
      expect(parsed.requiredCapabilities).toBe(7n);
      expect(parsed.rewardAmount).toBe(1_000_000_000n);
      expect(parsed.taskType).toBe(0);
      expect(parsed.deadline).toBe(1234567890);
      expect(parsed.minReputation).toBe(10);
      expect(parsed.rewardMint).toBe(TEST_KEY);
      expect(parsed.timestamp).toBe(789012);
    });

    it("should handle Uint8Array taskId input", () => {
      const taskId = new Uint8Array(32).fill(42);
      const raw = {
        taskId,
        creator: new PublicKey("11111111111111111111111111111111"),
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

  describe("parseTaskClaimedEvent", () => {
    it("should preserve u8 fields as numbers", () => {
      const workerKey = new PublicKey("11111111111111111111111111111111");
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

  describe("parseTaskCompletedEvent", () => {
    it("should convert proofHash and rewardPaid", () => {
      const raw = {
        taskId: Array.from({ length: 32 }, (_, i) => i),
        worker: new PublicKey("11111111111111111111111111111111"),
        proofHash: Array.from({ length: 32 }, (_, i) => 255 - i),
        resultData: Array.from({ length: 64 }, (_, i) => i % 256),
        rewardPaid: mockBN(2_500_000_000n),
        timestamp: mockBN(789012),
      };
      const parsed = parseTaskCompletedEvent(raw);
      expect(parsed.proofHash).toBeInstanceOf(Uint8Array);
      expect(parsed.proofHash.length).toBe(32);
      expect(parsed.proofHash[0]).toBe(255);
      expect(parsed.rewardPaid).toBe(2_500_000_000n);
      expect(parsed.resultData).toBeInstanceOf(Uint8Array);
      expect(parsed.resultData.length).toBe(64);
      expect(parsed.resultData[0]).toBe(0);
    });
  });

  describe("parseTaskCancelledEvent", () => {
    it("should convert refundAmount to bigint", () => {
      const raw = {
        taskId: new Uint8Array(32),
        creator: new PublicKey("11111111111111111111111111111111"),
        refundAmount: mockBN(1_500_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseTaskCancelledEvent(raw);
      expect(parsed.refundAmount).toBe(1_500_000_000n);
    });
  });

  describe("parseDependentTaskCreatedEvent", () => {
    it("should convert task and timestamp fields correctly", () => {
      const raw = {
        taskId: Array.from({ length: 32 }, (_, i) => i),
        creator: new PublicKey("11111111111111111111111111111111"),
        dependsOn: new PublicKey("11111111111111111111111111111112"),
        dependencyType: 2,
        rewardMint: null,
        timestamp: mockBN(987654321),
      };
      const parsed = parseDependentTaskCreatedEvent(raw);
      expect(parsed.taskId).toBeInstanceOf(Uint8Array);
      expect(parsed.taskId[0]).toBe(0);
      expect(parsed.dependsOn.toBase58()).toBe(raw.dependsOn.toBase58());
      expect(parsed.dependencyType).toBe(2);
      expect(parsed.rewardMint).toBeNull();
      expect(parsed.timestamp).toBe(987654321);
    });
  });

  describe("parseDisputeInitiatedEvent", () => {
    it("should convert both disputeId and taskId to Uint8Array", () => {
      const raw = {
        disputeId: Array.from({ length: 32 }, (_, i) => i),
        taskId: Array.from({ length: 32 }, (_, i) => 32 + i),
        initiator: new PublicKey("11111111111111111111111111111111"),
        defendant: new PublicKey("11111111111111111111111111111112"),
        resolutionType: 0,
        votingDeadline: mockBN(999999),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeInitiatedEvent(raw);
      expect(parsed.disputeId).toBeInstanceOf(Uint8Array);
      expect(parsed.taskId).toBeInstanceOf(Uint8Array);
      expect(parsed.disputeId[0]).toBe(0);
      expect(parsed.taskId[0]).toBe(32);
      expect(parsed.defendant.toBase58()).toBe(raw.defendant.toBase58());
      expect(parsed.votingDeadline).toBe(999999);
    });
  });

  describe("parseDisputeVoteCastEvent", () => {
    it("should convert votesFor/votesAgainst to bigint and preserve boolean", () => {
      const raw = {
        disputeId: new Uint8Array(32),
        voter: new PublicKey("11111111111111111111111111111111"),
        approved: true,
        votesFor: mockBN(5n),
        votesAgainst: mockBN(2n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeVoteCastEvent(raw);
      expect(parsed.approved).toBe(true);
      expect(parsed.votesFor).toBe(5n);
      expect(parsed.votesAgainst).toBe(2n);
      expect(typeof parsed.votesFor).toBe("bigint");
      expect(typeof parsed.votesAgainst).toBe("bigint");
    });
  });

  describe("parseDisputeResolvedEvent", () => {
    it("should convert votesFor/votesAgainst to bigint", () => {
      const raw = {
        disputeId: new Uint8Array(32),
        resolutionType: 2,
        outcome: 1,
        votesFor: mockBN(6n),
        votesAgainst: mockBN(1n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeResolvedEvent(raw);
      expect(parsed.resolutionType).toBe(2);
      expect(parsed.outcome).toBe(1);
      expect(parsed.votesFor).toBe(6n);
      expect(parsed.votesAgainst).toBe(1n);
    });
  });

  describe("parseDisputeExpiredEvent", () => {
    it("should convert refundAmount to bigint", () => {
      const raw = {
        disputeId: new Uint8Array(32),
        taskId: new Uint8Array(32),
        refundAmount: mockBN(800_000_000n),
        creatorAmount: mockBN(500_000_000n),
        workerAmount: mockBN(300_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseDisputeExpiredEvent(raw);
      expect(parsed.refundAmount).toBe(800_000_000n);
      expect(parsed.creatorAmount).toBe(500_000_000n);
      expect(parsed.workerAmount).toBe(300_000_000n);
    });
  });

  describe("parseDisputeCancelledEvent", () => {
    it("should parse raw dispute cancellation event", () => {
      const raw = {
        disputeId: new Uint8Array(32),
        task: new PublicKey("11111111111111111111111111111111"),
        initiator: new PublicKey("11111111111111111111111111111112"),
        cancelledAt: mockBN(5555555),
      };
      const parsed = parseDisputeCancelledEvent(raw);
      expect(parsed.disputeId).toBeInstanceOf(Uint8Array);
      expect(parsed.task.toBase58()).toBe(raw.task.toBase58());
      expect(parsed.initiator.toBase58()).toBe(raw.initiator.toBase58());
      expect(parsed.cancelledAt).toBe(5555555);
    });
  });

  describe("parseArbiterVotesCleanedUpEvent", () => {
    it("should parse arbiter cleanup count", () => {
      const raw = {
        disputeId: new Uint8Array(32),
        arbiterCount: 3,
      };
      const parsed = parseArbiterVotesCleanedUpEvent(raw);
      expect(parsed.disputeId).toBeInstanceOf(Uint8Array);
      expect(parsed.arbiterCount).toBe(3);
    });
  });

  describe("parseStateUpdatedEvent", () => {
    it("should convert stateKey to Uint8Array and version to bigint", () => {
      const raw = {
        stateKey: Array.from({ length: 32 }, (_, i) => i),
        stateValue: Array.from({ length: 64 }, (_, i) => i % 256),
        updater: new PublicKey("11111111111111111111111111111111"),
        version: mockBN(42n),
        timestamp: mockBN(123456),
      };
      const parsed = parseStateUpdatedEvent(raw);
      expect(parsed.stateKey).toBeInstanceOf(Uint8Array);
      expect(parsed.stateKey.length).toBe(32);
      expect(parsed.stateValue).toBeInstanceOf(Uint8Array);
      expect(parsed.stateValue.length).toBe(64);
      expect(parsed.version).toBe(42n);
    });
  });

  describe("parseProtocolInitializedEvent", () => {
    it("should preserve threshold and feeBps as numbers", () => {
      const raw = {
        authority: new PublicKey("11111111111111111111111111111111"),
        treasury: new PublicKey("11111111111111111111111111111112"),
        disputeThreshold: 66,
        protocolFeeBps: 250,
        timestamp: mockBN(123456),
      };
      const parsed = parseProtocolInitializedEvent(raw);
      expect(parsed.disputeThreshold).toBe(66);
      expect(parsed.protocolFeeBps).toBe(250);
    });
  });

  describe("parseRewardDistributedEvent", () => {
    it("should convert amount and protocolFee to bigint", () => {
      const raw = {
        taskId: new Uint8Array(32),
        recipient: new PublicKey("11111111111111111111111111111111"),
        amount: mockBN(1_000_000_000n),
        protocolFee: mockBN(25_000_000n),
        timestamp: mockBN(123456),
      };
      const parsed = parseRewardDistributedEvent(raw);
      expect(parsed.amount).toBe(1_000_000_000n);
      expect(parsed.protocolFee).toBe(25_000_000n);
    });
  });

  describe("parseRateLimitHitEvent", () => {
    it("should convert all fields correctly", () => {
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
      expect(typeof parsed.actionType).toBe("number");
      expect(typeof parsed.limitType).toBe("number");
    });
  });

  describe("parseMigrationCompletedEvent", () => {
    it("should preserve version numbers", () => {
      const raw = {
        fromVersion: 1,
        toVersion: 2,
        authority: new PublicKey("11111111111111111111111111111111"),
        timestamp: mockBN(123456),
      };
      const parsed = parseMigrationCompletedEvent(raw);
      expect(parsed.fromVersion).toBe(1);
      expect(parsed.toVersion).toBe(2);
    });
  });

  describe("parseProtocolVersionUpdatedEvent", () => {
    it("should preserve all version fields", () => {
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

  describe("parseRateLimitsUpdatedEvent", () => {
    it("should convert cooldowns and stake field", () => {
      const raw = {
        taskCreationCooldown: mockBN(600),
        maxTasksPer24h: 25,
        disputeInitiationCooldown: mockBN(900),
        maxDisputesPer24h: 7,
        minStakeForDispute: mockBN(777777),
        updatedBy: TEST_KEY,
        timestamp: mockBN(123456),
      };
      const parsed = parseRateLimitsUpdatedEvent(raw);
      expect(parsed.taskCreationCooldown).toBe(600);
      expect(parsed.disputeInitiationCooldown).toBe(900);
      expect(parsed.maxTasksPer24h).toBe(25);
      expect(parsed.maxDisputesPer24h).toBe(7);
      expect(parsed.minStakeForDispute).toBe(777777n);
      expect(parsed.updatedBy).toBe(raw.updatedBy);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseProtocolFeeUpdatedEvent", () => {
    it("should normalize protocol fee deltas", () => {
      const raw = {
        oldFeeBps: 250,
        newFeeBps: 300,
        updatedBy: TEST_KEY,
        timestamp: mockBN(123456),
      };
      const parsed = parseProtocolFeeUpdatedEvent(raw);
      expect(parsed.oldFeeBps).toBe(250);
      expect(parsed.newFeeBps).toBe(300);
      expect(parsed.updatedBy).toBe(raw.updatedBy);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseReputationChangedEvent", () => {
    it("should convert agent and reputation values", () => {
      const raw = {
        agentId: createId(1),
        oldReputation: 50,
        newReputation: 55,
        reason: 2,
        timestamp: mockBN(123456),
      };
      const parsed = parseReputationChangedEvent(raw);
      expect(parsed.agentId).toBeInstanceOf(Uint8Array);
      expect(parsed.agentId[0]).toBe(1);
      expect(parsed.oldReputation).toBe(50);
      expect(parsed.newReputation).toBe(55);
      expect(parsed.reason).toBe(2);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseBondDepositedEvent", () => {
    it("should parse and normalize deposit totals", () => {
      const raw = {
        agent: TEST_KEY,
        amount: mockBN(1_000_000_000),
        newTotal: mockBN(2_000_000_000),
        timestamp: mockBN(123456),
      };
      const parsed = parseBondDepositedEvent(raw);
      expect(parsed.agent).toBe(TEST_KEY);
      expect(parsed.amount).toBe(1_000_000_000n);
      expect(parsed.newTotal).toBe(2_000_000_000n);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseBondLockedEvent", () => {
    it("should parse locked commitment payload", () => {
      const raw = {
        agent: TEST_KEY,
        commitment: new PublicKey("11111111111111111111111111111113"),
        amount: mockBN(600_000_000),
        timestamp: mockBN(123456),
      };
      const parsed = parseBondLockedEvent(raw);
      expect(parsed.agent).toBe(TEST_KEY);
      expect(parsed.commitment.toBase58()).toBe(raw.commitment.toBase58());
      expect(parsed.amount).toBe(600_000_000n);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseBondReleasedEvent", () => {
    it("should parse released commitment payload", () => {
      const raw = {
        agent: TEST_KEY,
        commitment: new PublicKey("11111111111111111111111111111114"),
        amount: mockBN(600_000_000),
        timestamp: mockBN(123456),
      };
      const parsed = parseBondReleasedEvent(raw);
      expect(parsed.commitment.toBase58()).toBe(raw.commitment.toBase58());
      expect(parsed.amount).toBe(600_000_000n);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseBondSlashedEvent", () => {
    it("should parse slash payload including reason", () => {
      const raw = {
        agent: TEST_KEY,
        commitment: new PublicKey("11111111111111111111111111111115"),
        amount: mockBN(600_000_000),
        reason: 1,
        timestamp: mockBN(123456),
      };
      const parsed = parseBondSlashedEvent(raw);
      expect(parsed.reason).toBe(1);
      expect(parsed.amount).toBe(600_000_000n);
      expect(parsed.timestamp).toBe(123456);
    });
  });

  describe("parseSpeculativeCommitmentCreatedEvent", () => {
    it("should parse commitment hash and expiry", () => {
      const raw = {
        task: TEST_KEY,
        producer: new PublicKey("11111111111111111111111111111116"),
        resultHash: Array.from(new Uint8Array(32)),
        bondedStake: mockBN(500_000_000),
        expiresAt: mockBN(7777777),
        timestamp: mockBN(123456),
      };
      const parsed = parseSpeculativeCommitmentCreatedEvent(raw);
      expect(parsed.task).toBe(TEST_KEY);
      expect(parsed.producer.toBase58()).toBe(raw.producer.toBase58());
      expect(parsed.resultHash).toBeInstanceOf(Uint8Array);
      expect(parsed.resultHash.length).toBe(32);
      expect(parsed.bondedStake).toBe(500_000_000n);
      expect(parsed.expiresAt).toBe(7777777);
      expect(parsed.timestamp).toBe(123456);
    });
  });
});
