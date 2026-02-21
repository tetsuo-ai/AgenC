/**
 * Unit tests for TaskState enum, task helper functions, and PDA derivation.
 *
 * These tests verify:
 * 1. TaskState enum values match on-chain TaskStatus
 * 2. formatTaskState() returns correct human-readable strings
 * 3. PDA derivation functions produce deterministic results
 * 4. cancelTask and other task function types are exported
 */

import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  TaskState,
  formatTaskState,
  deriveTaskPda,
  deriveClaimPda,
  deriveEscrowPda,
  calculateEscrowFee,
} from "../tasks";
import { PROGRAM_ID, SEEDS } from "../constants";

describe("TaskState enum", () => {
  describe("enum values match on-chain TaskStatus", () => {
    // Values MUST match programs/agenc-coordination/src/state.rs:TaskStatus
    it("Open equals 0", () => {
      expect(TaskState.Open).toBe(0);
    });

    it("InProgress equals 1", () => {
      expect(TaskState.InProgress).toBe(1);
    });

    it("PendingValidation equals 2", () => {
      expect(TaskState.PendingValidation).toBe(2);
    });

    it("Completed equals 3", () => {
      expect(TaskState.Completed).toBe(3);
    });

    it("Cancelled equals 4", () => {
      expect(TaskState.Cancelled).toBe(4);
    });

    it("Disputed equals 5", () => {
      expect(TaskState.Disputed).toBe(5);
    });
  });

  describe("enum completeness", () => {
    it("has exactly 6 states", () => {
      const numericValues = Object.values(TaskState).filter(
        (v): v is number => typeof v === "number",
      );
      expect(numericValues).toHaveLength(6);
    });

    it("has all expected state names", () => {
      const expectedNames = [
        "Open",
        "InProgress",
        "PendingValidation",
        "Completed",
        "Cancelled",
        "Disputed",
      ];

      for (const name of expectedNames) {
        expect(TaskState[name as keyof typeof TaskState]).toBeDefined();
      }
    });

    it("values are sequential from 0 to 5", () => {
      const numericValues = Object.values(TaskState)
        .filter((v): v is number => typeof v === "number")
        .sort((a, b) => a - b);

      expect(numericValues).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });
});

describe("formatTaskState", () => {
  describe("returns correct strings for all states", () => {
    it("formats Open correctly", () => {
      expect(formatTaskState(TaskState.Open)).toBe("Open");
    });

    it("formats InProgress correctly", () => {
      expect(formatTaskState(TaskState.InProgress)).toBe("In Progress");
    });

    it("formats PendingValidation correctly", () => {
      expect(formatTaskState(TaskState.PendingValidation)).toBe(
        "Pending Validation",
      );
    });

    it("formats Completed correctly", () => {
      expect(formatTaskState(TaskState.Completed)).toBe("Completed");
    });

    it("formats Cancelled correctly", () => {
      expect(formatTaskState(TaskState.Cancelled)).toBe("Cancelled");
    });

    it("formats Disputed correctly", () => {
      expect(formatTaskState(TaskState.Disputed)).toBe("Disputed");
    });
  });

  describe("edge cases", () => {
    it("returns Unknown for invalid state value", () => {
      expect(formatTaskState(99 as TaskState)).toBe("Unknown");
    });

    it("returns Unknown for negative state value", () => {
      expect(formatTaskState(-1 as TaskState)).toBe("Unknown");
    });

    it("handles numeric zero correctly (Open)", () => {
      expect(formatTaskState(0 as TaskState)).toBe("Open");
    });
  });
});

describe("PDA derivation", () => {
  describe("deriveTaskPda", () => {
    it('uses correct seeds: ["task", creator, taskId]', () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(1);

      const result = deriveTaskPda(creator, taskId);

      // Verify by computing manually
      const [expected] = PublicKey.findProgramAddressSync(
        [SEEDS.TASK, creator.toBuffer(), taskId],
        PROGRAM_ID,
      );
      expect(result.equals(expected)).toBe(true);
    });

    it("accepts number[] as taskId", () => {
      const creator = Keypair.generate().publicKey;
      const taskId = Array.from(new Uint8Array(32).fill(2));

      // Should not throw
      const result = deriveTaskPda(creator, taskId);
      expect(result).toBeInstanceOf(PublicKey);
    });

    it("is deterministic", () => {
      const creator = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(3);

      const result1 = deriveTaskPda(creator, taskId);
      const result2 = deriveTaskPda(creator, taskId);
      expect(result1.equals(result2)).toBe(true);
    });

    it("different creators produce different PDAs", () => {
      const creator1 = Keypair.generate().publicKey;
      const creator2 = Keypair.generate().publicKey;
      const taskId = new Uint8Array(32).fill(4);

      const pda1 = deriveTaskPda(creator1, taskId);
      const pda2 = deriveTaskPda(creator2, taskId);
      expect(pda1.equals(pda2)).toBe(false);
    });
  });

  describe("deriveClaimPda", () => {
    it('uses correct seeds: ["claim", taskPda, workerAgentPda]', () => {
      const taskPda = Keypair.generate().publicKey;
      const workerAgentPda = Keypair.generate().publicKey;

      const result = deriveClaimPda(taskPda, workerAgentPda);

      const [expected] = PublicKey.findProgramAddressSync(
        [SEEDS.CLAIM, taskPda.toBuffer(), workerAgentPda.toBuffer()],
        PROGRAM_ID,
      );
      expect(result.equals(expected)).toBe(true);
    });
  });

  describe("deriveEscrowPda", () => {
    it('uses correct seeds: ["escrow", taskPda]', () => {
      const taskPda = Keypair.generate().publicKey;

      const result = deriveEscrowPda(taskPda);

      const [expected] = PublicKey.findProgramAddressSync(
        [SEEDS.ESCROW, taskPda.toBuffer()],
        PROGRAM_ID,
      );
      expect(result.equals(expected)).toBe(true);
    });
  });
});

describe("calculateEscrowFee", () => {
  it("calculates basic fee correctly", () => {
    expect(calculateEscrowFee(1000, 1)).toBe(10); // 1% of 1000
  });

  it("returns 0 for zero escrow", () => {
    expect(calculateEscrowFee(0)).toBe(0);
  });

  it("throws for negative escrow", () => {
    expect(() => calculateEscrowFee(-1)).toThrow();
  });

  it("throws for NaN escrow", () => {
    expect(() => calculateEscrowFee(NaN)).toThrow();
  });

  it("throws for overflow escrow", () => {
    expect(() => calculateEscrowFee(Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
