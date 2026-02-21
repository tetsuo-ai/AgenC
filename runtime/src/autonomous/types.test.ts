import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Task, TaskStatus, DefaultClaimStrategy } from "./types.js";

// Generate deterministic test keys
const TEST_PDA = Keypair.generate().publicKey;
const TEST_CREATOR = Keypair.generate().publicKey;

/**
 * Create a mock task for testing
 */
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    pda: TEST_PDA,
    taskId: new Uint8Array(32).fill(1),
    creator: TEST_CREATOR,
    requiredCapabilities: 1n,
    reward: 100_000_000n, // 0.1 SOL
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
    ...overrides,
  };
}

describe("TaskStatus enum", () => {
  it("has correct values", () => {
    expect(TaskStatus.Open).toBe(0);
    expect(TaskStatus.InProgress).toBe(1);
    expect(TaskStatus.Completed).toBe(2);
    expect(TaskStatus.Cancelled).toBe(3);
    expect(TaskStatus.Disputed).toBe(4);
  });
});

describe("DefaultClaimStrategy", () => {
  it("claims when no pending tasks", () => {
    const task = createMockTask();
    expect(DefaultClaimStrategy.shouldClaim(task, 0)).toBe(true);
  });

  it("does not claim when tasks are pending", () => {
    const task = createMockTask();
    expect(DefaultClaimStrategy.shouldClaim(task, 1)).toBe(false);
    expect(DefaultClaimStrategy.shouldClaim(task, 5)).toBe(false);
  });

  it("prioritizes by reward amount", () => {
    const lowReward = createMockTask({ reward: 50_000_000n });
    const highReward = createMockTask({ reward: 500_000_000n });

    expect(DefaultClaimStrategy.priority(highReward)).toBeGreaterThan(
      DefaultClaimStrategy.priority(lowReward),
    );
  });
});

describe("Task interface", () => {
  it("can be created with all required fields", () => {
    const task = createMockTask();

    expect(task.pda).toBeDefined();
    expect(task.taskId).toHaveLength(32);
    expect(task.creator).toBeDefined();
    expect(typeof task.requiredCapabilities).toBe("bigint");
    expect(typeof task.reward).toBe("bigint");
    expect(task.description).toHaveLength(64);
    expect(task.constraintHash).toHaveLength(32);
    expect(typeof task.deadline).toBe("number");
    expect(typeof task.maxWorkers).toBe("number");
    expect(typeof task.currentClaims).toBe("number");
    expect(task.status).toBe(TaskStatus.Open);
  });

  it("identifies private tasks by non-zero constraint hash", () => {
    const publicTask = createMockTask({ constraintHash: new Uint8Array(32) });
    const privateTask = createMockTask({
      constraintHash: new Uint8Array(32).fill(1),
    });

    const isPrivate = (task: Task) =>
      !task.constraintHash.every((b) => b === 0);

    expect(isPrivate(publicTask)).toBe(false);
    expect(isPrivate(privateTask)).toBe(true);
  });
});
