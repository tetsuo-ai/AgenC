import { describe, expect, it } from "vitest";
import { validateGatewayConfig } from "./config-watcher.js";

function makeConfig(desktop?: Record<string, unknown>): Record<string, unknown> {
  return {
    gateway: { port: 3100 },
    agent: { name: "test-agent" },
    connection: { rpcUrl: "http://127.0.0.1:8899" },
    ...(desktop ? { desktop } : {}),
  };
}

const AUTH_SECRET = "test-secret-that-is-at-least-32-chars!!";

describe("validateGatewayConfig desktop resource limits", () => {
  it("accepts valid desktop.maxMemory and desktop.maxCpu", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "8g",
        maxCpu: "2.5",
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects invalid desktop.maxMemory format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "eight-gb",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxMemory must be a string like 512m or 4g (plain integers are treated as GB)",
    );
  });

  it("rejects invalid desktop.maxCpu format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "two",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxCpu must be a positive numeric string like 0.5 or 2.0",
    );
  });

  it("rejects non-positive desktop.maxCpu values", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "0",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("desktop.maxCpu must be greater than 0");
  });

  it("accepts llm.subagents.policyLearning config with arm offsets", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        policyLearning: {
          enabled: true,
          epsilon: 0.15,
          explorationBudget: 1000,
          minSamplesPerArm: 2,
          ucbExplorationScale: 1.3,
          arms: [
            { id: "conservative", thresholdOffset: 0.1 },
            { id: "balanced", thresholdOffset: 0 },
            { id: "aggressive", thresholdOffset: -0.1 },
          ],
        },
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects llm.subagents.policyLearning arm thresholdOffset outside bounds", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        policyLearning: {
          arms: [{ id: "broken", thresholdOffset: 2 }],
        },
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "llm.subagents.policyLearning.arms[0].thresholdOffset must be a number between -1 and 1",
    );
  });

  it("accepts subagent open-question controls", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        mode: "handoff",
        delegationAggressiveness: "adaptive",
        handoffMinPlannerConfidence: 0.85,
        childProviderStrategy: "capability_matched",
        hardBlockedTaskClasses: [
          "wallet_signing",
          "wallet_transfer",
          "stake_or_rewards",
        ],
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid subagent open-question controls", () => {
    const config = makeConfig();
    config.llm = {
      provider: "grok",
      subagents: {
        enabled: true,
        delegationAggressiveness: "extreme",
        handoffMinPlannerConfidence: 1.2,
        childProviderStrategy: "random",
        hardBlockedTaskClasses: ["bad_class"],
      },
    };
    const result = validateGatewayConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "llm.subagents.delegationAggressiveness must be one of: conservative, balanced, aggressive, adaptive",
    );
    expect(result.errors).toContain(
      "llm.subagents.handoffMinPlannerConfidence must be a number between 0 and 1",
    );
    expect(result.errors).toContain(
      "llm.subagents.childProviderStrategy must be one of: same_as_parent, capability_matched",
    );
    expect(result.errors).toContain(
      "llm.subagents.hardBlockedTaskClasses[0] must be one of: wallet_signing, wallet_transfer, stake_or_rewards, destructive_host_mutation, credential_exfiltration",
    );
  });

});

describe("validateGatewayConfig auth safety for bind address", () => {
  it("rejects non-local bind without auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "0.0.0.0" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "auth.secret is required when gateway.bind is non-local",
    );
  });

  it("accepts non-local bind with auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "0.0.0.0" },
      auth: { secret: AUTH_SECRET },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts loopback bind without auth.secret", () => {
    const result = validateGatewayConfig({
      ...makeConfig(),
      gateway: { port: 3100, bind: "127.0.0.1" },
    });
    expect(result.valid).toBe(true);
  });
});
