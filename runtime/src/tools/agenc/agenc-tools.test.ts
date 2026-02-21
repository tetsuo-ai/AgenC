import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createAgencTools } from "./index.js";
import {
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from "./tools.js";
import type { ToolContext } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { OnChainTaskStatus } from "../../task/types.js";
import { TaskType } from "../../events/types.js";

// ============================================================================
// Mock Data Factories
// ============================================================================

const TASK_PDA = PublicKey.unique();
const AGENT_PDA = PublicKey.unique();
const CREATOR = PublicKey.unique();
const ESCROW = PublicKey.unique();
const SIGNER = PublicKey.unique();
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function makeMockTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: new Uint8Array(32),
    creator: CREATOR,
    requiredCapabilities: 3n, // COMPUTE | INFERENCE
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    rewardAmount: 1_000_000_000n,
    maxWorkers: 1,
    currentWorkers: 0,
    status: OnChainTaskStatus.Open,
    taskType: TaskType.Exclusive,
    createdAt: 1700000000,
    deadline: 1700003600,
    completedAt: 0,
    escrow: ESCROW,
    result: new Uint8Array(64),
    completions: 0,
    requiredCompletions: 1,
    bump: 255,
    rewardMint: null,
    ...overrides,
  };
}

function makeMockAgent() {
  return {
    agentId: new Uint8Array(32),
    authority: PublicKey.unique(),
    capabilities: { toString: () => "1" },
    status: { active: {} },
    registeredAt: { toNumber: () => 1700000000 },
    lastActive: { toNumber: () => 1700000100 },
    endpoint: "agent://test",
    metadataUri: "",
    tasksCompleted: { toString: () => "5" },
    totalEarned: { toString: () => "5000000000" },
    reputation: 8000,
    activeTasks: 1,
    stake: { toString: () => "1000000000" },
    lastTaskCreated: { toNumber: () => 0 },
    lastDisputeInitiated: { toNumber: () => 0 },
    taskCount24H: 0,
    disputeCount24H: 0,
    rateLimitWindowStart: { toNumber: () => 0 },
    activeDisputeVotes: 0,
    lastVoteTimestamp: { toNumber: () => 0 },
    lastStateUpdate: { toNumber: () => 0 },
    disputesAsDefendant: 0,
    bump: 254,
  };
}

function makeMockProtocolConfig() {
  return {
    authority: PublicKey.unique(),
    treasury: PublicKey.unique(),
    disputeThreshold: 51,
    protocolFeeBps: 100,
    minArbiterStake: { toString: () => "5000000000" },
    minAgentStake: { toString: () => "1000000000" },
    maxClaimDuration: { toNumber: () => 3600 },
    maxDisputeDuration: { toNumber: () => 86400 },
    totalAgents: { toString: () => "10" },
    totalTasks: { toString: () => "50" },
    completedTasks: { toString: () => "40" },
    totalValueDistributed: { toString: () => "100000000000" },
    bump: 255,
    multisigThreshold: 2,
    multisigOwnersLen: 3,
    taskCreationCooldown: { toNumber: () => 60 },
    maxTasksPer24H: 10,
    disputeInitiationCooldown: { toNumber: () => 300 },
    maxDisputesPer24H: 2,
    minStakeForDispute: { toString: () => "2000000000" },
    slashPercentage: 10,
    stateUpdateCooldown: { toNumber: () => 60 },
    votingPeriod: { toNumber: () => 86400 },
    protocolVersion: 1,
    minSupportedVersion: 1,
    multisigOwners: [
      PublicKey.unique(),
      PublicKey.unique(),
      PublicKey.unique(),
    ],
  };
}

// ============================================================================
// Mock TaskOperations
// ============================================================================

function createMockOps() {
  return {
    fetchClaimableTasks: vi.fn(async () => [
      { task: makeMockTask(), taskPda: TASK_PDA },
      {
        task: makeMockTask({ status: OnChainTaskStatus.InProgress }),
        taskPda: PublicKey.unique(),
      },
    ]),
    fetchAllTasks: vi.fn(async () => [
      { task: makeMockTask(), taskPda: TASK_PDA },
      {
        task: makeMockTask({ status: OnChainTaskStatus.InProgress }),
        taskPda: PublicKey.unique(),
      },
      {
        task: makeMockTask({ status: OnChainTaskStatus.Completed }),
        taskPda: PublicKey.unique(),
      },
    ]),
    fetchTask: vi.fn(async (pda: PublicKey) => {
      if (pda.equals(TASK_PDA)) return makeMockTask();
      return null;
    }),
    fetchEscrowTokenBalance: vi.fn(async () => 123_456n),
  };
}

// ============================================================================
// Mock Program
// ============================================================================

function createMockProgram() {
  const methodChain = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: vi.fn(async () => "mock-create-task-sig"),
  };

  return {
    programId: PublicKey.unique(),
    provider: {
      publicKey: SIGNER,
      connection: {
        getTokenAccountBalance: vi.fn(async () => ({
          context: { slot: 1 },
          value: {
            amount: "2500000",
            decimals: 6,
            uiAmount: 2.5,
            uiAmountString: "2.5",
          },
        })),
      },
    },
    account: {
      agentRegistration: {
        fetch: vi.fn(async (pda: PublicKey) => {
          if (pda.equals(AGENT_PDA)) return makeMockAgent();
          throw new Error("Account does not exist");
        }),
        all: vi.fn(async () => [
          {
            publicKey: AGENT_PDA,
            account: {
              authority: SIGNER,
            },
          },
        ]),
      },
      protocolConfig: {
        fetch: vi.fn(async () => makeMockProtocolConfig()),
      },
    },
    methods: {
      createTask: vi.fn().mockReturnValue(methodChain),
    },
    _methodChain: methodChain,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("createAgencTools", () => {
  it("returns all built-in agenc tools", () => {
    const mockProgram =
      createMockProgram() as unknown as ToolContext["program"];
    const tools = createAgencTools({
      connection: {} as ToolContext["connection"],
      program: mockProgram,
      logger: silentLogger,
    });

    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agenc.createTask",
      "agenc.getAgent",
      "agenc.getProtocolConfig",
      "agenc.getTask",
      "agenc.getTokenBalance",
      "agenc.listTasks",
    ]);
  });
});

describe("agenc.listTasks", () => {
  let tool: ReturnType<typeof createListTasksTool>;
  let mockOps: ReturnType<typeof createMockOps>;

  beforeEach(() => {
    mockOps = createMockOps();
    tool = createListTasksTool(mockOps as never, silentLogger);
  });

  it("uses fetchClaimableTasks for open status (default)", async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchClaimableTasks).toHaveBeenCalled();
    expect(mockOps.fetchAllTasks).not.toHaveBeenCalled();
    expect(parsed.count).toBe(1); // Only Open tasks
  });

  it("uses fetchClaimableTasks for in_progress status", async () => {
    const result = await tool.execute({ status: "in_progress" });
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchClaimableTasks).toHaveBeenCalled();
    expect(mockOps.fetchAllTasks).not.toHaveBeenCalled();
    expect(parsed.count).toBe(1); // Only InProgress tasks
  });

  it("uses fetchAllTasks for all status", async () => {
    const result = await tool.execute({ status: "all" });
    const parsed = JSON.parse(result.content);

    expect(mockOps.fetchAllTasks).toHaveBeenCalled();
    expect(parsed.count).toBe(3);
  });

  it("respects limit parameter", async () => {
    const result = await tool.execute({ status: "all", limit: 1 });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(3);
  });

  it("clamps limit to MAX_LIMIT", async () => {
    const result = await tool.execute({ status: "all", limit: 999 });
    const parsed = JSON.parse(result.content);

    // Should still work (just capped at 200)
    expect(parsed.count).toBe(3);
  });

  it("returns valid task fields", async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0]).toHaveProperty("taskPda");
    expect(parsed.tasks[0]).toHaveProperty("status", "Open");
    expect(parsed.tasks[0]).toHaveProperty("rewardSol");
    expect(parsed.tasks[0]).toHaveProperty("requiredCapabilities");
    expect(parsed.tasks[0]).toHaveProperty("isPrivate");
  });

  it("serializes rewardMint as null for SOL tasks", async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0]).toHaveProperty("rewardMint", null);
  });

  it("serializes rewardMint as base58 for token tasks", async () => {
    const TOKEN_MINT = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      { task: makeMockTask({ rewardMint: TOKEN_MINT }), taskPda: TASK_PDA },
    ]);

    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(parsed.tasks[0].rewardMint).toBe(TOKEN_MINT.toBase58());
  });

  it("filters list by rewardMint base58", async () => {
    const mintA = PublicKey.unique();
    const mintB = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      {
        task: makeMockTask({ rewardMint: mintA }),
        taskPda: PublicKey.unique(),
      },
      {
        task: makeMockTask({ rewardMint: mintB }),
        taskPda: PublicKey.unique(),
      },
      { task: makeMockTask({ rewardMint: null }), taskPda: PublicKey.unique() },
    ]);

    const result = await tool.execute({ rewardMint: mintB.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0].rewardMint).toBe(mintB.toBase58());
  });

  it("filters list by SOL rewardMint alias", async () => {
    const mintA = PublicKey.unique();
    mockOps.fetchClaimableTasks.mockResolvedValueOnce([
      {
        task: makeMockTask({ rewardMint: mintA }),
        taskPda: PublicKey.unique(),
      },
      { task: makeMockTask({ rewardMint: null }), taskPda: PublicKey.unique() },
    ]);

    const result = await tool.execute({ rewardMint: "SOL" });
    const parsed = JSON.parse(result.content);

    expect(parsed.count).toBe(1);
    expect(parsed.tasks[0].rewardMint).toBeNull();
  });
});

describe("agenc.getTask", () => {
  let tool: ReturnType<typeof createGetTaskTool>;
  let mockOps: ReturnType<typeof createMockOps>;

  beforeEach(() => {
    mockOps = createMockOps();
    tool = createGetTaskTool(mockOps as never, silentLogger);
  });

  it("returns task details for valid PDA", async () => {
    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.taskPda).toBe(TASK_PDA.toBase58());
    expect(parsed.status).toBe("Open");
  });

  it("includes escrow token balance for token tasks", async () => {
    mockOps.fetchTask.mockResolvedValueOnce(
      makeMockTask({ rewardMint: USDC_MINT, escrow: ESCROW }),
    );
    mockOps.fetchEscrowTokenBalance.mockResolvedValueOnce(123n);

    const result = await tool.execute({ taskPda: TASK_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(parsed.rewardMint).toBe(USDC_MINT.toBase58());
    expect(parsed.escrowTokenBalance).toBe("123");
    expect(parsed.escrowTokenAccount).toBeTypeOf("string");
  });

  it("returns isError for invalid base58", async () => {
    const result = await tool.execute({ taskPda: "not-valid-base58!!!" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("Invalid base58");
  });

  it("returns isError for not-found task", async () => {
    const result = await tool.execute({
      taskPda: PublicKey.unique().toBase58(),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not found");
  });

  it("returns isError for missing taskPda", async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });
});

describe("agenc.getTokenBalance", () => {
  it("returns token balance for mint and default owner", async () => {
    const mockProgram = createMockProgram();
    const tool = createGetTokenBalanceTool(mockProgram as never, silentLogger);

    const result = await tool.execute({ mint: USDC_MINT.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.mint).toBe(USDC_MINT.toBase58());
    expect(parsed.owner).toBe(SIGNER.toBase58());
    expect(parsed.amount).toBe("2500000");
  });
});

describe("agenc.createTask", () => {
  it("creates a SOL task with defaults", async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);

    const result = await tool.execute({
      description: "hello task",
      reward: "1000000",
      requiredCapabilities: "1",
    });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.taskPda).toBeTypeOf("string");
    expect(parsed.transactionSignature).toBe("mock-create-task-sig");
    expect(parsed.rewardMint).toBeNull();
    expect(mockProgram.methods.createTask).toHaveBeenCalledOnce();
  });

  it("rejects unknown reward mints", async () => {
    const mockProgram = createMockProgram();
    const tool = createCreateTaskTool(mockProgram as never, silentLogger);
    const unknownMint = PublicKey.unique();

    const result = await tool.execute({
      description: "hello task",
      reward: "1000000",
      requiredCapabilities: "1",
      rewardMint: unknownMint.toBase58(),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "Unsupported rewardMint",
    );
  });
});

describe("agenc.getAgent", () => {
  let tool: ReturnType<typeof createGetAgentTool>;

  beforeEach(() => {
    const mockProgram = createMockProgram();
    tool = createGetAgentTool(mockProgram as never, silentLogger);
  });

  it("returns agent details for valid PDA", async () => {
    const result = await tool.execute({ agentPda: AGENT_PDA.toBase58() });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed.agentPda).toBe(AGENT_PDA.toBase58());
    expect(parsed.status).toBe("Active");
    expect(parsed.capabilities).toContain("COMPUTE");
  });

  it("returns isError for invalid base58", async () => {
    const result = await tool.execute({ agentPda: "!!!invalid" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("Invalid base58");
  });

  it("returns isError for not-found agent", async () => {
    const result = await tool.execute({
      agentPda: PublicKey.unique().toBase58(),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not found");
  });
});

describe("agenc.getProtocolConfig", () => {
  let tool: ReturnType<typeof createGetProtocolConfigTool>;

  beforeEach(() => {
    const mockProgram = createMockProgram();
    tool = createGetProtocolConfigTool(mockProgram as never, silentLogger);
  });

  it("returns protocol config", async () => {
    const result = await tool.execute({});
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(parsed).toHaveProperty("protocolFeeBps", 100);
    expect(parsed).toHaveProperty("disputeThreshold", 51);
    expect(parsed).toHaveProperty("protocolVersion", 1);
    expect(parsed).toHaveProperty("totalTasks", "50");
  });
});
