import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { TaskExecutor, VerifierVerdictPayload } from "./types.js";
import { AutonomousAgent } from "./agent.js";
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
          minRiskScoreToVerify: 0.35,
          mediumRiskThreshold: 0.3,
          highRiskThreshold: 0.5,
          maxVerificationRetriesByRisk: {
            low: 0,
            medium: 1,
            high: 2,
          },
          maxVerificationDurationMsByRisk: {
            low: 10_000,
            medium: 30_000,
            high: 60_000,
          },
          minConfidenceByRisk: {
            low: 0.6,
            medium: 0.75,
            high: 0.9,
          },
          hardMaxVerificationRetries: 2,
          hardMaxVerificationDurationMs: 60_000,
          hardMaxVerificationCostLamports: 100_000_000_000n,
        },
      },
    },
  });
}

describe("AutonomousAgent adaptive risk integration", () => {
  it("skips verifier lane for low-risk tasks when adaptive threshold is not met", async () => {
    const executor = {
      execute: vi.fn(async () => [1n, 2n]),
    };

    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "ok" }],
      }),
    );

    const agent = createAgent(executor, verify);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "tx-low-risk");

    const lowRiskTask = makeTask({
      reward: 10n,
      taskType: 0,
      deadline: 0,
      maxWorkers: 4,
      currentClaims: 0,
    });

    const result = await agentAny.executeSequential(
      lowRiskTask,
      {
        task: lowRiskTask,
        claimedAt: Date.now(),
        claimTx: "claim-low",
        retryCount: 0,
      },
      lowRiskTask.pda.toBase58(),
    );

    expect(result.success).toBe(true);
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("allocates larger verifier budget for high-risk tasks", async () => {
    const executor = {
      execute: vi.fn(async () => [5n, 6n]),
    };

    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "fail",
        confidence: 0.4,
        reasons: [{ code: "first_fail", message: "first fail" }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "pass" }],
      } satisfies VerifierVerdictPayload);

    const agent = createAgent(executor, verify);
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "tx-high-risk");

    const nowSeconds = Math.floor(Date.now() / 1000);
    const highRiskTask = makeTask({
      reward: 5_000_000_000n,
      taskType: 2,
      deadline: nowSeconds + 30,
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
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledTimes(1);
  });
});
