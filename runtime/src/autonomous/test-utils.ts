import { Keypair } from "@solana/web3.js";
import { TaskStatus, type Task, type VerifierLaneConfig } from "./types.js";

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    pda: Keypair.generate().publicKey,
    taskId: new Uint8Array(32).fill(1),
    creator: Keypair.generate().publicKey,
    requiredCapabilities: 1n,
    reward: 100n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: TaskStatus.Open,
    rewardMint: null,
    ...overrides,
  };
}

export function createVerifierConfig(
  overrides: Partial<VerifierLaneConfig> = {},
): VerifierLaneConfig {
  return {
    verifier: {
      verify: async () => ({
        verdict: "pass",
        confidence: 0.9,
        reasons: [{ code: "ok", message: "ok" }],
      }),
    },
    minConfidence: 0.75,
    maxVerificationRetries: 2,
    maxVerificationDurationMs: 30_000,
    ...overrides,
  };
}
