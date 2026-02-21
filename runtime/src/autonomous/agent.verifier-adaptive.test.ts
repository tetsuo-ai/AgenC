import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { AutonomousAgent } from "./agent.js";
import { type TaskExecutor, type VerifierVerdictPayload } from "./types.js";
import { createTask as makeTask } from "./test-utils.js";

function createAgent(
  executor: TaskExecutor,
  verify: (input: unknown) => Promise<VerifierVerdictPayload>,
): AutonomousAgent {
  return new AutonomousAgent({
    connection: {} as any,
    wallet: Keypair.generate(),
    capabilities: 1n,
    executor,
    verifier: {
      verifier: { verify },
      maxVerificationRetries: 2,
      maxVerificationDurationMs: 60_000,
      policy: {
        enabled: true,
        adaptiveRisk: {
          enabled: true,
          minRiskScoreToVerify: 0,
          mediumRiskThreshold: 0.3,
          highRiskThreshold: 0.55,
          routeByRisk: {
            low: "single_pass",
            high: "revision_first",
          },
          maxVerificationRetriesByRisk: {
            low: 0,
            medium: 1,
            high: 2,
          },
          maxDisagreementsByRisk: {
            low: 1,
            medium: 2,
            high: 3,
          },
        },
      },
    },
  });
}

describe("AutonomousAgent adaptive verifier scheduler", () => {
  it("uses strict low-risk single-pass route", async () => {
    const executor = {
      execute: vi.fn(async () => [1n]),
    };

    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "fail",
        confidence: 0.4,
        reasons: [{ code: "fail", message: "single pass fail" }],
      }),
    );

    const agent = createAgent(executor, verify);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "tx-low");

    const lowRiskTask = makeTask({
      reward: 10n,
      taskType: 0,
      maxWorkers: 4,
      currentClaims: 0,
    });

    await expect(
      agentAny.executeSequential(
        lowRiskTask,
        {
          task: lowRiskTask,
          claimedAt: Date.now(),
          claimTx: "claim-low",
          retryCount: 0,
        },
        lowRiskTask.pda.toBase58(),
      ),
    ).rejects.toThrow("Verifier lane escalated");

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("uses high-risk revision route with multiple attempts", async () => {
    const executor = {
      execute: vi.fn(async () => [2n]),
      revise: vi.fn(async () => [9n]),
    };

    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "needs_revision",
        confidence: 0.7,
        reasons: [{ code: "needs_revision", message: "refine output" }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "approved" }],
      } satisfies VerifierVerdictPayload);

    const agent = createAgent(executor, verify);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "tx-high");

    const highRiskTask = makeTask({
      reward: 5_000_000_000n,
      taskType: 2,
      deadline: Math.floor(Date.now() / 1000) + 30,
      maxWorkers: 1,
      currentClaims: 1,
    });

    const result = await agentAny.executeSequential(
      highRiskTask,
      {
        task: highRiskTask,
        claimedAt: Date.now(),
        claimTx: "claim-high",
        retryCount: 0,
      },
      highRiskTask.pda.toBase58(),
    );

    expect(result.success).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(executor.revise).toHaveBeenCalledTimes(1);
  });
});
