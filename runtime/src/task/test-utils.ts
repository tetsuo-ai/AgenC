import { Keypair } from "@solana/web3.js";
import { vi } from "vitest";
import type { TaskOperations } from "./operations.js";
import type {
  TaskDiscovery,
  TaskDiscoveryResult,
  TaskDiscoveryListener,
} from "./discovery.js";
import type { ProofPipeline } from "./proof-pipeline.js";
import type {
  OnChainTask,
  OnChainTaskClaim,
  ClaimResult,
  CompleteResult,
} from "./types.js";
import { OnChainTaskStatus } from "./types.js";
import { TaskType } from "../events/types.js";

const COMPUTE = 1n << 0n;

export function createTask(overrides: Partial<OnChainTask> = {}): OnChainTask {
  const rewardMint = overrides.rewardMint ?? null;
  return {
    taskId: new Uint8Array(32),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: COMPUTE,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000n,
    maxWorkers: 5,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    completedAt: 0,
    escrow: Keypair.generate().publicKey,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    ...overrides,
    rewardMint,
  };
}

export function randomPda() {
  return Keypair.generate().publicKey;
}

export function createSpeculationTask(
  overrides: Partial<OnChainTask> = {},
): OnChainTask {
  return createTask({
    taskId: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
    creator: randomPda(),
    requiredCapabilities: 0n,
    createdAt: Math.floor(Date.now() / 1000),
    deadline: 0,
    escrow: randomPda(),
    ...overrides,
  });
}

export function createDiscoveryResult(
  overrides: Partial<TaskDiscoveryResult> = {},
): TaskDiscoveryResult {
  return {
    pda: Keypair.generate().publicKey,
    task: createTask(),
    discoveredAt: Date.now(),
    source: "poll",
    ...overrides,
  };
}

export function createMockOperations(): TaskOperations & {
  claimTask: ReturnType<typeof vi.fn>;
  completeTask: ReturnType<typeof vi.fn>;
  completeTaskPrivate: ReturnType<typeof vi.fn>;
  fetchTask: ReturnType<typeof vi.fn>;
  fetchTaskByIds: ReturnType<typeof vi.fn>;
  fetchClaim: ReturnType<typeof vi.fn>;
} {
  const claimPda = Keypair.generate().publicKey;
  return {
    fetchClaimableTasks: vi.fn().mockResolvedValue([]),
    fetchTask: vi.fn().mockResolvedValue(null),
    fetchAllTasks: vi.fn().mockResolvedValue([]),
    fetchClaim: vi.fn().mockResolvedValue(null),
    fetchActiveClaims: vi.fn().mockResolvedValue([]),
    fetchTaskByIds: vi.fn().mockResolvedValue(null),
    claimTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      claimPda,
      transactionSignature: "claim-sig",
    } satisfies ClaimResult),
    completeTask: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      isPrivate: false,
      transactionSignature: "complete-sig",
    } satisfies CompleteResult),
    completeTaskPrivate: vi.fn().mockResolvedValue({
      success: true,
      taskId: new Uint8Array(32),
      isPrivate: true,
      transactionSignature: "private-complete-sig",
    } satisfies CompleteResult),
  } as unknown as TaskOperations & {
    claimTask: ReturnType<typeof vi.fn>;
    completeTask: ReturnType<typeof vi.fn>;
    completeTaskPrivate: ReturnType<typeof vi.fn>;
    fetchTask: ReturnType<typeof vi.fn>;
    fetchTaskByIds: ReturnType<typeof vi.fn>;
    fetchClaim: ReturnType<typeof vi.fn>;
  };
}

export function createMockProofPipeline(): ProofPipeline {
  return {
    queueProofGeneration: vi.fn(),
    submitProof: vi.fn().mockResolvedValue("mock-signature"),
    getQueuedJobs: vi.fn().mockReturnValue([]),
    getActiveJobs: vi.fn().mockReturnValue([]),
    getCompletedJobs: vi.fn().mockReturnValue([]),
    getFailedJobs: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      queued: 0,
      generating: 0,
      generated: 0,
      submitting: 0,
      confirmed: 0,
      failed: 0,
      totalProcessed: 0,
      averageGenerationTimeMs: 0,
      averageSubmissionTimeMs: 0,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    isShuttingDown: vi.fn().mockReturnValue(false),
    cancel: vi.fn(),
  } as unknown as ProofPipeline;
}

export function createMockDiscovery(): TaskDiscovery & {
  onTaskDiscovered: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  _emitTask: (task: TaskDiscoveryResult) => void;
} {
  let listener: TaskDiscoveryListener | null = null;

  const mock = {
    onTaskDiscovered: vi.fn((cb: TaskDiscoveryListener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    isPaused: vi.fn().mockReturnValue(false),
    getDiscoveredCount: vi.fn().mockReturnValue(0),
    clearSeen: vi.fn(),
    poll: vi.fn().mockResolvedValue([]),
    _emitTask: (task: TaskDiscoveryResult) => {
      listener?.(task);
    },
  };

  return mock as unknown as TaskDiscovery & {
    onTaskDiscovered: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    _emitTask: (task: TaskDiscoveryResult) => void;
  };
}

export function createMockClaim(
  overrides: Partial<OnChainTaskClaim> = {},
): OnChainTaskClaim {
  return {
    task: Keypair.generate().publicKey,
    worker: Keypair.generate().publicKey,
    claimedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    completedAt: 0,
    proofHash: new Uint8Array(32),
    resultData: new Uint8Array(64),
    isCompleted: false,
    isValidated: false,
    rewardPaid: 0n,
    bump: 255,
    ...overrides,
  };
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
