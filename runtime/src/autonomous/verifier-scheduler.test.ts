import { describe, expect, it } from "vitest";
import { planVerifierSchedule } from "./verifier-scheduler.js";

describe("planVerifierSchedule", () => {
  it("preserves backward-compatible legacy scheduling when adaptive mode is disabled", () => {
    const plan = planVerifierSchedule({
      adaptiveEnabled: false,
      riskTier: "medium",
      baseMaxAttempts: 3,
      hasRevisionExecutor: true,
      reexecuteOnNeedsRevision: false,
    });

    expect(plan.route).toBe("revision_first");
    expect(plan.maxAttempts).toBe(3);
    expect(plan.maxDisagreements).toBe(Number.MAX_SAFE_INTEGER);
    expect(plan.metadata.source).toBe("legacy");
  });

  it("selects stricter low-risk plan and richer high-risk plan", () => {
    const low = planVerifierSchedule({
      adaptiveEnabled: true,
      riskTier: "low",
      baseMaxAttempts: 4,
      hasRevisionExecutor: true,
      reexecuteOnNeedsRevision: false,
    });

    const high = planVerifierSchedule({
      adaptiveEnabled: true,
      riskTier: "high",
      baseMaxAttempts: 4,
      hasRevisionExecutor: true,
      reexecuteOnNeedsRevision: false,
    });

    expect(low.route).toBe("single_pass");
    expect(low.maxAttempts).toBe(1);
    expect(high.route).toBe("revision_first");
    expect(high.maxAttempts).toBe(4);
    expect(high.maxDisagreements).toBeGreaterThan(low.maxDisagreements);
  });

  it("keeps revision-first strategy when configured for high risk", () => {
    const plan = planVerifierSchedule({
      adaptiveEnabled: true,
      riskTier: "high",
      baseMaxAttempts: 2,
      hasRevisionExecutor: false,
      reexecuteOnNeedsRevision: true,
      adaptiveRiskConfig: {
        enabled: true,
        routeByRisk: {
          high: "revision_first",
        },
      },
    });

    expect(plan.route).toBe("revision_first");
    expect(plan.maxAttempts).toBe(2);
  });
});
