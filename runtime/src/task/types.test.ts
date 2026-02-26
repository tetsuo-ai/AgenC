import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TaskType } from "../events/types.js";
import {
  OnChainTaskStatus,
  parseTaskStatus,
  parseTaskType,
  parseOnChainTask,
  parseOnChainTaskClaim,
  isPrivateTask,
  isTaskExpired,
  isTaskClaimable,
  isPrivateExecutionResult,
  taskStatusToString,
  taskTypeToString,
  type OnChainTask,
  type TaskExecutionResult,
  type PrivateTaskExecutionResult,
} from "./types.js";

/**
 * Creates a mock raw task matching RawOnChainTask shape.
 */
function createMockRawTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: new Array(32).fill(0).map((_: number, i: number) => i),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: { toString: () => "3" },
    description: new Array(64).fill(0),
    constraintHash: new Array(32).fill(0),
    rewardAmount: { toString: () => "1000000" },
    maxWorkers: 5,
    currentWorkers: 0,
    status: { open: {} },
    taskType: { exclusive: {} },
    createdAt: { toNumber: () => 1700000000 },
    deadline: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    escrow: Keypair.generate().publicKey,
    result: new Array(64).fill(0),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

/**
 * Creates a mock raw task claim matching RawOnChainTaskClaim shape.
 */
function createMockRawTaskClaim(overrides: Record<string, unknown> = {}) {
  return {
    task: Keypair.generate().publicKey,
    worker: Keypair.generate().publicKey,
    claimedAt: { toNumber: () => 1700000000 },
    expiresAt: { toNumber: () => 1700003600 },
    completedAt: { toNumber: () => 0 },
    proofHash: new Array(32).fill(0),
    resultData: new Array(64).fill(0),
    isCompleted: false,
    isValidated: false,
    rewardPaid: { toString: () => "0" },
    bump: 254,
    ...overrides,
  };
}

/**
 * Creates a parsed OnChainTask for utility function tests.
 */
function createParsedTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  return {
    taskId: new Uint8Array(32),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 3n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700003600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
  };
}

describe("OnChainTaskStatus enum", () => {
  it("has correct numeric values", () => {
    expect(OnChainTaskStatus.Open).toBe(0);
    expect(OnChainTaskStatus.InProgress).toBe(1);
    expect(OnChainTaskStatus.PendingValidation).toBe(2);
    expect(OnChainTaskStatus.Completed).toBe(3);
    expect(OnChainTaskStatus.Cancelled).toBe(4);
    expect(OnChainTaskStatus.Disputed).toBe(5);
  });

  it("has all 6 variants", () => {
    const values = [
      OnChainTaskStatus.Open,
      OnChainTaskStatus.InProgress,
      OnChainTaskStatus.PendingValidation,
      OnChainTaskStatus.Completed,
      OnChainTaskStatus.Cancelled,
      OnChainTaskStatus.Disputed,
    ];
    expect(values.length).toBe(6);
    // Verify all are unique
    expect(new Set(values).size).toBe(6);
  });
});

describe("parseTaskStatus", () => {
  it("parses numeric values (0-5)", () => {
    expect(parseTaskStatus(0)).toBe(OnChainTaskStatus.Open);
    expect(parseTaskStatus(1)).toBe(OnChainTaskStatus.InProgress);
    expect(parseTaskStatus(2)).toBe(OnChainTaskStatus.PendingValidation);
    expect(parseTaskStatus(3)).toBe(OnChainTaskStatus.Completed);
    expect(parseTaskStatus(4)).toBe(OnChainTaskStatus.Cancelled);
    expect(parseTaskStatus(5)).toBe(OnChainTaskStatus.Disputed);
  });

  it("parses Anchor enum objects", () => {
    expect(parseTaskStatus({ open: {} })).toBe(OnChainTaskStatus.Open);
    expect(parseTaskStatus({ inProgress: {} })).toBe(
      OnChainTaskStatus.InProgress,
    );
    expect(parseTaskStatus({ pendingValidation: {} })).toBe(
      OnChainTaskStatus.PendingValidation,
    );
    expect(parseTaskStatus({ completed: {} })).toBe(
      OnChainTaskStatus.Completed,
    );
    expect(parseTaskStatus({ cancelled: {} })).toBe(
      OnChainTaskStatus.Cancelled,
    );
    expect(parseTaskStatus({ disputed: {} })).toBe(OnChainTaskStatus.Disputed);
  });

  it("throws on invalid numeric input", () => {
    expect(() => parseTaskStatus(6)).toThrow("Invalid task status value: 6");
    expect(() => parseTaskStatus(-1)).toThrow("Invalid task status value: -1");
  });

  it("throws on invalid object input", () => {
    expect(() => parseTaskStatus({} as any)).toThrow(
      "Invalid task status format",
    );
  });
});

describe("parseTaskType", () => {
  it("parses numeric values (0-2)", () => {
    expect(parseTaskType(0)).toBe(TaskType.Exclusive);
    expect(parseTaskType(1)).toBe(TaskType.Collaborative);
    expect(parseTaskType(2)).toBe(TaskType.Competitive);
  });

  it("parses Anchor enum objects", () => {
    expect(parseTaskType({ exclusive: {} })).toBe(TaskType.Exclusive);
    expect(parseTaskType({ collaborative: {} })).toBe(TaskType.Collaborative);
    expect(parseTaskType({ competitive: {} })).toBe(TaskType.Competitive);
  });

  it("throws on invalid input", () => {
    expect(() => parseTaskType(3)).toThrow("Invalid task type value: 3");
    expect(() => parseTaskType({} as any)).toThrow("Invalid task type format");
  });
});

describe("parseOnChainTask", () => {
  it("converts BN fields to bigint", () => {
    const raw = createMockRawTask();
    const parsed = parseOnChainTask(raw);

    expect(typeof parsed.requiredCapabilities).toBe("bigint");
    expect(typeof parsed.rewardAmount).toBe("bigint");
    expect(parsed.requiredCapabilities).toBe(3n);
    expect(parsed.rewardAmount).toBe(1_000_000n);
  });

  it("converts BN timestamp fields to number", () => {
    const raw = createMockRawTask();
    const parsed = parseOnChainTask(raw);

    expect(typeof parsed.createdAt).toBe("number");
    expect(typeof parsed.deadline).toBe("number");
    expect(typeof parsed.completedAt).toBe("number");
    expect(parsed.createdAt).toBe(1700000000);
    expect(parsed.deadline).toBe(1700003600);
    expect(parsed.completedAt).toBe(0);
  });

  it("converts number[] to Uint8Array", () => {
    const raw = createMockRawTask();
    const parsed = parseOnChainTask(raw);

    expect(parsed.taskId).toBeInstanceOf(Uint8Array);
    expect(parsed.description).toBeInstanceOf(Uint8Array);
    expect(parsed.constraintHash).toBeInstanceOf(Uint8Array);
    expect(parsed.result).toBeInstanceOf(Uint8Array);
    expect(parsed.taskId.length).toBe(32);
    expect(parsed.description.length).toBe(64);
    expect(parsed.constraintHash.length).toBe(32);
    expect(parsed.result.length).toBe(64);
  });

  it("preserves Uint8Array passthrough", () => {
    const taskId = new Uint8Array(32).fill(42);
    const raw = createMockRawTask({ taskId });
    const parsed = parseOnChainTask(raw);

    expect(parsed.taskId).toBeInstanceOf(Uint8Array);
    expect(parsed.taskId[0]).toBe(42);
  });

  it("preserves PublicKey passthrough", () => {
    const creator = Keypair.generate().publicKey;
    const escrow = Keypair.generate().publicKey;
    const raw = createMockRawTask({ creator, escrow });
    const parsed = parseOnChainTask(raw);

    expect(parsed.creator.equals(creator)).toBe(true);
    expect(parsed.escrow.equals(escrow)).toBe(true);
  });

  it("handles zero deadline (no deadline)", () => {
    const raw = createMockRawTask({ deadline: { toNumber: () => 0 } });
    const parsed = parseOnChainTask(raw);

    expect(parsed.deadline).toBe(0);
  });

  it("handles zero constraintHash (not private)", () => {
    const raw = createMockRawTask({ constraintHash: new Array(32).fill(0) });
    const parsed = parseOnChainTask(raw);

    expect(parsed.constraintHash.every((b: number) => b === 0)).toBe(true);
  });

  it("parses status enum from Anchor object format", () => {
    const raw = createMockRawTask({ status: { inProgress: {} } });
    const parsed = parseOnChainTask(raw);

    expect(parsed.status).toBe(OnChainTaskStatus.InProgress);
  });

  it("parses taskType enum from Anchor object format", () => {
    const raw = createMockRawTask({ taskType: { competitive: {} } });
    const parsed = parseOnChainTask(raw);

    expect(parsed.taskType).toBe(TaskType.Competitive);
  });

  it("preserves numeric fields", () => {
    const raw = createMockRawTask({
      maxWorkers: 10,
      currentWorkers: 3,
      completions: 2,
      requiredCompletions: 5,
      bump: 200,
    });
    const parsed = parseOnChainTask(raw);

    expect(parsed.maxWorkers).toBe(10);
    expect(parsed.currentWorkers).toBe(3);
    expect(parsed.completions).toBe(2);
    expect(parsed.requiredCompletions).toBe(5);
    expect(parsed.bump).toBe(200);
  });

  it("throws on invalid data", () => {
    expect(() => parseOnChainTask(null)).toThrow("Invalid task data");
    expect(() => parseOnChainTask({})).toThrow("Invalid task data");
    expect(() => parseOnChainTask("not an object")).toThrow(
      "Invalid task data",
    );
  });
});

describe("parseOnChainTaskClaim", () => {
  it("converts all fields correctly", () => {
    const raw = createMockRawTaskClaim({
      claimedAt: { toNumber: () => 1700000000 },
      expiresAt: { toNumber: () => 1700003600 },
      completedAt: { toNumber: () => 1700001000 },
      rewardPaid: { toString: () => "500000" },
      isCompleted: true,
      isValidated: true,
      bump: 253,
    });
    const parsed = parseOnChainTaskClaim(raw);

    expect(parsed.claimedAt).toBe(1700000000);
    expect(parsed.expiresAt).toBe(1700003600);
    expect(parsed.completedAt).toBe(1700001000);
    expect(parsed.rewardPaid).toBe(500_000n);
    expect(parsed.isCompleted).toBe(true);
    expect(parsed.isValidated).toBe(true);
    expect(parsed.bump).toBe(253);
  });

  it("handles uncompleted claim", () => {
    const raw = createMockRawTaskClaim({
      completedAt: { toNumber: () => 0 },
      isCompleted: false,
      rewardPaid: { toString: () => "0" },
    });
    const parsed = parseOnChainTaskClaim(raw);

    expect(parsed.completedAt).toBe(0);
    expect(parsed.isCompleted).toBe(false);
    expect(parsed.rewardPaid).toBe(0n);
  });

  it("converts proofHash and resultData byte arrays", () => {
    const proofHash = new Array(32).fill(0).map((_: number, i: number) => i);
    const resultData = new Array(64)
      .fill(0)
      .map((_: number, i: number) => i % 256);
    const raw = createMockRawTaskClaim({ proofHash, resultData });
    const parsed = parseOnChainTaskClaim(raw);

    expect(parsed.proofHash).toBeInstanceOf(Uint8Array);
    expect(parsed.resultData).toBeInstanceOf(Uint8Array);
    expect(parsed.proofHash.length).toBe(32);
    expect(parsed.resultData.length).toBe(64);
    expect(parsed.proofHash[0]).toBe(0);
    expect(parsed.proofHash[1]).toBe(1);
  });

  it("preserves PublicKey fields", () => {
    const task = Keypair.generate().publicKey;
    const worker = Keypair.generate().publicKey;
    const raw = createMockRawTaskClaim({ task, worker });
    const parsed = parseOnChainTaskClaim(raw);

    expect(parsed.task.equals(task)).toBe(true);
    expect(parsed.worker.equals(worker)).toBe(true);
  });

  it("throws on invalid data", () => {
    expect(() => parseOnChainTaskClaim(null)).toThrow(
      "Invalid task claim data",
    );
    expect(() => parseOnChainTaskClaim({})).toThrow("Invalid task claim data");
  });
});

describe("isPrivateTask", () => {
  it("returns true when constraintHash has any non-zero byte", () => {
    const constraintHash = new Uint8Array(32);
    constraintHash[15] = 1;
    const task = createParsedTask({ constraintHash });

    expect(isPrivateTask(task)).toBe(true);
  });

  it("returns false when constraintHash is all zeros", () => {
    const task = createParsedTask({ constraintHash: new Uint8Array(32) });

    expect(isPrivateTask(task)).toBe(false);
  });
});

describe("isTaskExpired", () => {
  it("returns false when deadline is 0 (no deadline)", () => {
    const task = createParsedTask({ deadline: 0 });

    expect(isTaskExpired(task)).toBe(false);
  });

  it("returns false when deadline is in the future", () => {
    const futureDeadline = Math.floor(Date.now() / 1000) + 3600;
    const task = createParsedTask({ deadline: futureDeadline });

    expect(isTaskExpired(task)).toBe(false);
  });

  it("returns true when deadline has passed", () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 3600;
    const task = createParsedTask({ deadline: pastDeadline });

    expect(isTaskExpired(task)).toBe(true);
  });

  it("accepts optional nowUnix parameter for deterministic testing", () => {
    const task = createParsedTask({ deadline: 1700003600 });

    // Before deadline
    expect(isTaskExpired(task, 1700000000)).toBe(false);
    // After deadline
    expect(isTaskExpired(task, 1700010000)).toBe(true);
    // Exactly at deadline (not expired, since we need > not >=)
    expect(isTaskExpired(task, 1700003600)).toBe(false);
  });
});

describe("isTaskClaimable", () => {
  it("returns true for Open task with available slots and not expired", () => {
    const task = createParsedTask({
      status: OnChainTaskStatus.Open,
      maxWorkers: 5,
      currentWorkers: 0,
    });

    expect(isTaskClaimable(task)).toBe(true);
  });

  it("returns false for Completed status", () => {
    const task = createParsedTask({ status: OnChainTaskStatus.Completed });

    expect(isTaskClaimable(task)).toBe(false);
  });

  it("returns false for Cancelled status", () => {
    const task = createParsedTask({ status: OnChainTaskStatus.Cancelled });

    expect(isTaskClaimable(task)).toBe(false);
  });

  it("returns false for Disputed status", () => {
    const task = createParsedTask({ status: OnChainTaskStatus.Disputed });

    expect(isTaskClaimable(task)).toBe(false);
  });

  it("returns false for InProgress status", () => {
    // isTaskClaimable only checks Open status
    const task = createParsedTask({ status: OnChainTaskStatus.InProgress });

    expect(isTaskClaimable(task)).toBe(false);
  });

  it("returns false when currentWorkers >= maxWorkers", () => {
    const task = createParsedTask({
      status: OnChainTaskStatus.Open,
      maxWorkers: 3,
      currentWorkers: 3,
    });

    expect(isTaskClaimable(task)).toBe(false);
  });
});

describe("isPrivateExecutionResult", () => {
  it("identifies PrivateTaskExecutionResult by RISC0 payload fields", () => {
    const result: PrivateTaskExecutionResult = {
      sealBytes: new Uint8Array(260),
      journal: new Uint8Array(256),
      imageId: new Uint8Array(32),
      bindingSeed: new Uint8Array(32),
      nullifierSeed: new Uint8Array(32),
    };

    expect(isPrivateExecutionResult(result)).toBe(true);
  });

  it("identifies TaskExecutionResult as non-private", () => {
    const result: TaskExecutionResult = {
      proofHash: new Uint8Array(32),
    };

    expect(isPrivateExecutionResult(result)).toBe(false);
  });

  it("does not match object with only seal bytes (missing journal fields)", () => {
    const result = {
      sealBytes: new Uint8Array(260),
      proofHash: new Uint8Array(32),
    } as TaskExecutionResult;

    expect(isPrivateExecutionResult(result)).toBe(false);
  });
});

describe("taskStatusToString", () => {
  it("converts all status values to strings", () => {
    expect(taskStatusToString(OnChainTaskStatus.Open)).toBe("Open");
    expect(taskStatusToString(OnChainTaskStatus.InProgress)).toBe("InProgress");
    expect(taskStatusToString(OnChainTaskStatus.PendingValidation)).toBe(
      "PendingValidation",
    );
    expect(taskStatusToString(OnChainTaskStatus.Completed)).toBe("Completed");
    expect(taskStatusToString(OnChainTaskStatus.Cancelled)).toBe("Cancelled");
    expect(taskStatusToString(OnChainTaskStatus.Disputed)).toBe("Disputed");
  });

  it("returns Unknown for invalid values", () => {
    expect(taskStatusToString(99 as OnChainTaskStatus)).toBe("Unknown (99)");
  });
});

describe("taskTypeToString", () => {
  it("converts all type values to strings", () => {
    expect(taskTypeToString(TaskType.Exclusive)).toBe("Exclusive");
    expect(taskTypeToString(TaskType.Collaborative)).toBe("Collaborative");
    expect(taskTypeToString(TaskType.Competitive)).toBe("Competitive");
  });

  it("returns Unknown for invalid values", () => {
    expect(taskTypeToString(99 as TaskType)).toBe("Unknown (99)");
  });
});
