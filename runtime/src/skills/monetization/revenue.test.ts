import { describe, it, expect } from "vitest";
import { computeRevenueShare } from "./revenue.js";
import { SkillRevenueError } from "./errors.js";
import {
  DEVELOPER_REVENUE_BPS,
  PROTOCOL_REVENUE_BPS,
  REVENUE_BPS_DENOMINATOR,
} from "./types.js";

describe("computeRevenueShare", () => {
  const baseInput = {
    taskRewardLamports: 1_000_000n,
    skillAuthor: "author-pubkey",
    protocolTreasury: "treasury-pubkey",
  };

  it("uses default 80/20 split", () => {
    const result = computeRevenueShare(baseInput);

    expect(result.developerBps).toBe(DEVELOPER_REVENUE_BPS);
    expect(result.protocolBps).toBe(PROTOCOL_REVENUE_BPS);
    // 1_000_000 * 2000 / 10_000 = 200_000 protocol
    expect(result.protocolShare).toBe(200_000n);
    // developer gets remainder
    expect(result.developerShare).toBe(800_000n);
    expect(result.developerShare + result.protocolShare).toBe(
      baseInput.taskRewardLamports,
    );
  });

  it("accepts custom BPS split", () => {
    const result = computeRevenueShare({
      ...baseInput,
      developerBps: 9000,
      protocolBps: 1000,
    });

    expect(result.developerBps).toBe(9000);
    expect(result.protocolBps).toBe(1000);
    expect(result.protocolShare).toBe(100_000n);
    expect(result.developerShare).toBe(900_000n);
  });

  it("returns zero shares for zero reward", () => {
    const result = computeRevenueShare({
      ...baseInput,
      taskRewardLamports: 0n,
    });

    expect(result.developerShare).toBe(0n);
    expect(result.protocolShare).toBe(0n);
    expect(result.taskRewardLamports).toBe(0n);
  });

  it("throws on negative reward", () => {
    expect(() =>
      computeRevenueShare({
        ...baseInput,
        taskRewardLamports: -1n,
      }),
    ).toThrow(SkillRevenueError);
  });

  it("throws when BPS do not sum to denominator", () => {
    expect(() =>
      computeRevenueShare({
        ...baseInput,
        developerBps: 5000,
        protocolBps: 4000,
      }),
    ).toThrow(SkillRevenueError);
  });

  it("throws on negative developerBps", () => {
    expect(() =>
      computeRevenueShare({
        ...baseInput,
        developerBps: -1,
        protocolBps: REVENUE_BPS_DENOMINATOR + 1,
      }),
    ).toThrow(SkillRevenueError);
  });

  it("throws on non-integer protocolBps", () => {
    expect(() =>
      computeRevenueShare({
        ...baseInput,
        developerBps: 7999,
        protocolBps: 2000.5,
      }),
    ).toThrow(SkillRevenueError);
  });

  it("remainder goes to developer (favor creator)", () => {
    // 3 lamports, 80/20 → protocol = 3 * 2000 / 10000 = 0 (integer div)
    // developer gets the full 3
    const result = computeRevenueShare({
      ...baseInput,
      taskRewardLamports: 3n,
    });

    expect(result.protocolShare).toBe(0n);
    expect(result.developerShare).toBe(3n);
    expect(result.developerShare + result.protocolShare).toBe(3n);
  });

  it("handles remainder for non-trivial amounts", () => {
    // 7 lamports, 80/20 → protocol = 7 * 2000 / 10000 = 1 (integer div)
    // developer gets 6
    const result = computeRevenueShare({
      ...baseInput,
      taskRewardLamports: 7n,
    });

    expect(result.protocolShare).toBe(1n);
    expect(result.developerShare).toBe(6n);
  });

  it("handles large amounts correctly", () => {
    const largeReward = 1_000_000_000_000n; // 1000 SOL
    const result = computeRevenueShare({
      ...baseInput,
      taskRewardLamports: largeReward,
    });

    expect(result.protocolShare).toBe(200_000_000_000n);
    expect(result.developerShare).toBe(800_000_000_000n);
    expect(result.developerShare + result.protocolShare).toBe(largeReward);
  });

  it("preserves author and treasury fields", () => {
    const result = computeRevenueShare(baseInput);

    expect(result.skillAuthor).toBe("author-pubkey");
    expect(result.protocolTreasury).toBe("treasury-pubkey");
  });

  it("100% developer / 0% protocol", () => {
    const result = computeRevenueShare({
      ...baseInput,
      developerBps: 10_000,
      protocolBps: 0,
    });

    expect(result.developerShare).toBe(1_000_000n);
    expect(result.protocolShare).toBe(0n);
  });

  it("0% developer / 100% protocol", () => {
    const result = computeRevenueShare({
      ...baseInput,
      developerBps: 0,
      protocolBps: 10_000,
    });

    expect(result.developerShare).toBe(0n);
    expect(result.protocolShare).toBe(1_000_000n);
  });
});
