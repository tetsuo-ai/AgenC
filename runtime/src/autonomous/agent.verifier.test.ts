import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { TaskExecutor, VerifierVerdictPayload } from "./types.js";
import { AutonomousAgent } from "./agent.js";
import { createTask } from "./test-utils.js";

function createBaseAgent(
  executor: TaskExecutor,
  overrides: Partial<ConstructorParameters<typeof AutonomousAgent>[0]> = {},
): AutonomousAgent {
  return new AutonomousAgent({
    connection: {} as any,
    wallet: Keypair.generate(),
    capabilities: 1n,
    executor,
    ...overrides,
  });
}

describe("AutonomousAgent verifier lane integration", () => {
  it("does not submit completion when verifier escalates", async () => {
    const executor = {
      execute: vi.fn(async () => [1n, 2n]),
    };
    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "fail",
        confidence: 0.1,
        reasons: [{ code: "bad_output", message: "Output invalid" }],
      }),
    );

    const agent = createBaseAgent(executor, {
      verifier: {
        verifier: { verify },
        maxVerificationRetries: 0,
      },
    });

    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "should-not-submit");

    const task = createTask();
    await expect(
      agentAny.executeSequential(
        task,
        {
          task,
          claimedAt: Date.now(),
          claimTx: "claim-tx",
          retryCount: 0,
        },
        task.pda.toBase58(),
      ),
    ).rejects.toThrow("Verifier lane escalated");

    expect(agentAny.completeTaskWithRetry).not.toHaveBeenCalled();
  });

  it("submits completion after revise then verifier pass", async () => {
    const executor = {
      execute: vi.fn(async () => [10n]),
      revise: vi.fn(async () => [99n]),
    };
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "needs_revision",
        confidence: 0.45,
        reasons: [{ code: "format", message: "Needs correction" }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce({
        verdict: "pass",
        confidence: 0.92,
        reasons: [{ code: "ok", message: "Approved" }],
      } satisfies VerifierVerdictPayload);
    const onTaskExecuted = vi.fn();

    const agent = createBaseAgent(executor, {
      verifier: {
        verifier: { verify },
        maxVerificationRetries: 1,
      },
      onTaskExecuted,
    });

    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "complete-tx");

    const task = createTask();
    const result = await agentAny.executeSequential(
      task,
      {
        task,
        claimedAt: Date.now(),
        claimTx: "claim-tx",
        retryCount: 0,
      },
      task.pda.toBase58(),
    );

    expect(result.success).toBe(true);
    expect(result.completionTx).toBe("complete-tx");
    expect(executor.revise).toHaveBeenCalledTimes(1);
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledTimes(1);
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledWith(task, [99n]);
    expect(onTaskExecuted).toHaveBeenCalledWith(task, [99n]);
  });

  it("bypasses speculative flow when verifier gate applies", async () => {
    const executor = {
      execute: vi.fn(async () => [1n]),
    };
    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "pass",
        confidence: 0.9,
        reasons: [{ code: "ok", message: "Pass" }],
      }),
    );

    const agent = createBaseAgent(executor, {
      verifier: { verifier: { verify } },
    });
    const agentAny = agent as any;

    agentAny.specExecutor = {};
    agentAny.claimTaskWithRetry = vi.fn(async () => "claim-tx");
    agentAny.executeSpeculative = vi.fn(async () => ({
      success: true,
      task: createTask(),
      durationMs: 1,
    }));
    agentAny.executeSequential = vi.fn(async () => ({
      success: true,
      task: createTask(),
      completionTx: "complete-tx",
      durationMs: 1,
    }));

    const result = await agentAny.claimAndProcess(createTask());
    expect(result.success).toBe(true);
    expect(agentAny.executeSpeculative).not.toHaveBeenCalled();
    expect(agentAny.executeSequential).toHaveBeenCalledTimes(1);
  });

  it("keeps speculative flow for tasks outside verifier policy", async () => {
    const executor = {
      execute: vi.fn(async () => [1n]),
    };
    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "Pass" }],
      }),
    );

    const agent = createBaseAgent(executor, {
      verifier: {
        verifier: { verify },
        policy: {
          enabled: true,
          minRewardLamports: 10_000n,
        },
      },
    });
    const agentAny = agent as any;

    const lowRewardTask = createTask({ reward: 100n });
    agentAny.specExecutor = {};
    agentAny.claimTaskWithRetry = vi.fn(async () => "claim-tx");
    agentAny.executeSpeculative = vi.fn(async () => ({
      success: true,
      task: lowRewardTask,
      durationMs: 1,
    }));
    agentAny.executeSequential = vi.fn(async () => ({
      success: true,
      task: lowRewardTask,
      completionTx: "complete-tx",
      durationMs: 1,
    }));

    const result = await agentAny.claimAndProcess(lowRewardTask);
    expect(result.success).toBe(true);
    expect(agentAny.executeSpeculative).toHaveBeenCalledTimes(1);
    expect(agentAny.executeSequential).not.toHaveBeenCalled();
  });
});
