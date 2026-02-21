import { describe, expect, it } from "vitest";
import {
  BPS_BASE,
  DEFAULT_WEIGHTED_SCORE_WEIGHTS,
  canonicalizeMarketplaceId,
  validateMarketplaceId,
  isValidBps,
} from "../bids";

describe("bids contracts", () => {
  it("exports expected constants", () => {
    expect(BPS_BASE).toBe(10_000);
    expect(DEFAULT_WEIGHTED_SCORE_WEIGHTS).toEqual({
      priceWeightBps: 4_000,
      etaWeightBps: 3_000,
      confidenceWeightBps: 2_000,
      reliabilityWeightBps: 1_000,
    });
  });

  it("canonicalizes marketplace identifiers", () => {
    expect(canonicalizeMarketplaceId("  Task:ABC-01  ")).toBe("task:abc-01");
  });

  it("validates marketplace identifiers", () => {
    expect(validateMarketplaceId("task:abc_01")).toBeNull();
    expect(validateMarketplaceId("")).toContain("must not be empty");
    expect(validateMarketplaceId("UPPER")).toContain("must match");
    expect(validateMarketplaceId("invalid space")).toContain("must match");
  });

  it("validates bps values", () => {
    expect(isValidBps(0)).toBe(true);
    expect(isValidBps(10_000)).toBe(true);
    expect(isValidBps(10_001)).toBe(false);
    expect(isValidBps(-1)).toBe(false);
    expect(isValidBps(123.45)).toBe(false);
  });
});
