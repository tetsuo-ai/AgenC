import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import type { TaskExecutor, VerifierVerdictPayload } from "./types.js";
import { AutonomousAgent } from "./agent.js";
import { VerifierLaneEscalationError } from "./verifier.js";
import { createTask } from "./test-utils.js";

function createBaseAgent(
  executor: TaskExecutor,
  verify: (input: { output: bigint[] }) => Promise<VerifierVerdictPayload>,
  overrides: Partial<ConstructorParameters<typeof AutonomousAgent>[0]> = {},
): AutonomousAgent {
  return new AutonomousAgent({
    connection: {} as any,
    wallet: Keypair.generate(),
    capabilities: 1n,
    executor,
    verifier: {
      verifier: { verify },
      maxVerificationRetries: 0,
    },
    multiCandidate: {
      enabled: true,
      seed: 19,
      maxCandidates: 2,
      policyBudget: {
        maxCandidates: 2,
        maxExecutionCostLamports: 200n,
      },
    },
    ...overrides,
  });
}

describe("AutonomousAgent multi-candidate integration", () => {
  it("arbitrates bounded candidates and verifies the selected output", async () => {
    const executor = {
      execute: vi.fn().mockResolvedValueOnce([1n]).mockResolvedValueOnce([2n]),
    };
    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "pass" }],
      }),
    );

    const agent = createBaseAgent(executor, verify);
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
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0].output).toEqual([1n]);
    expect(agentAny.completeTaskWithRetry).toHaveBeenCalledWith(task, [1n]);
  });

  it("escalates when candidate disagreement crosses threshold under verifier gating", async () => {
    const executor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([11n])
        .mockResolvedValueOnce([22n]),
    };
    const verify = vi.fn(
      async (): Promise<VerifierVerdictPayload> => ({
        verdict: "pass",
        confidence: 0.95,
        reasons: [{ code: "ok", message: "pass" }],
      }),
    );

    const agent = createBaseAgent(executor, verify, {
      memory: new InMemoryBackend(),
      multiCandidate: {
        enabled: true,
        maxCandidates: 2,
        policyBudget: {
          maxCandidates: 2,
          maxExecutionCostLamports: 200n,
        },
        escalation: {
          maxPairwiseDisagreements: 1,
        },
      },
    });
    const agentAny = agent as any;
    agentAny.completeTaskWithRetry = vi.fn(async () => "should-not-complete");

    const task = createTask();

    try {
      await agentAny.executeSequential(
        task,
        {
          task,
          claimedAt: Date.now(),
          claimTx: "claim-tx",
          retryCount: 0,
        },
        task.pda.toBase58(),
      );
      throw new Error("expected verifier disagreement escalation");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifierLaneEscalationError);
      const typed = error as VerifierLaneEscalationError;
      expect(typed.metadata.reason).toBe("verifier_disagreement");
      expect(typed.metadata.details?.["reasonCodes"]).toEqual(
        expect.arrayContaining(["value_mismatch", "semantic_distance"]),
      );
      expect(typed.metadata.details?.["provenanceLinkIds"]).toEqual(
        expect.any(Array),
      );
    }

    expect(verify).not.toHaveBeenCalled();
    expect(agentAny.completeTaskWithRetry).not.toHaveBeenCalled();
  });
});
