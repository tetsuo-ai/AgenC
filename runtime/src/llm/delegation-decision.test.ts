import { describe, it, expect } from "vitest";
import {
  assessDelegationDecision,
  resolveDelegationDecisionConfig,
} from "./delegation-decision.js";

describe("delegation-decision", () => {
  it("normalizes delegation scoring config bounds", () => {
    const resolved = resolveDelegationDecisionConfig({
      enabled: true,
      mode: "handoff",
      scoreThreshold: 2,
      maxFanoutPerTurn: 0,
      maxDepth: -1,
      handoffMinPlannerConfidence: 2,
      hardBlockedTaskClasses: ["wallet_transfer", "destructive_host_mutation"],
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.mode).toBe("handoff");
    expect(resolved.scoreThreshold).toBe(1);
    expect(resolved.maxFanoutPerTurn).toBe(1);
    expect(resolved.maxDepth).toBe(1);
    expect(resolved.handoffMinPlannerConfidence).toBe(1);
    expect(resolved.hardBlockedTaskClasses.has("wallet_transfer")).toBe(true);
    expect(
      resolved.hardBlockedTaskClasses.has("destructive_host_mutation"),
    ).toBe(true);
  });

  it("vetoes trivial single-hop plans", () => {
    const decision = assessDelegationDecision({
      messageText: "First run one quick check and report.",
      complexityScore: 4,
      totalSteps: 1,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "quick_check",
          acceptanceCriteria: ["return one status"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["workspace_root"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.65 },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("trivial_request");
  });

  it("vetoes delegation when fanout exceeds configured guardrail", () => {
    const decision = assessDelegationDecision({
      messageText: "Analyze module A and module B, then summarize.",
      complexityScore: 7,
      totalSteps: 2,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "a",
          acceptanceCriteria: ["evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["module_a"],
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
        {
          name: "b",
          acceptanceCriteria: ["evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["module_b"],
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
      ],
      config: {
        enabled: true,
        scoreThreshold: 0.2,
        maxFanoutPerTurn: 1,
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("fanout_exceeded");
  });

  it("approves delegation when utility clears threshold and guardrails", () => {
    const decision = assessDelegationDecision({
      messageText:
        "First cluster CI failures, then map source hotspots, then merge findings into one remediation plan.",
      complexityScore: 9,
      totalSteps: 3,
      synthesisSteps: 1,
      edges: [{ from: "logs", to: "code" }],
      subagentSteps: [
        {
          name: "logs",
          acceptanceCriteria: ["cluster failures", "cite evidence"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["ci_logs", "recent_failures"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
        {
          name: "code",
          dependsOn: ["logs"],
          acceptanceCriteria: ["map hotspots to clusters"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["runtime_sources", "test_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.utilityScore).toBeGreaterThanOrEqual(0.2);
  });

  it("hard-blocks delegation for wallet transfer/signing task classes", () => {
    const decision = assessDelegationDecision({
      messageText: "Sign and send SOL transfer from treasury wallet.",
      complexityScore: 8,
      totalSteps: 2,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "transfer",
          acceptanceCriteria: ["signed tx", "transfer receipt"],
          requiredToolCapabilities: ["wallet.transfer"],
          contextRequirements: ["treasury_wallet"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
      ],
      config: {
        enabled: true,
        scoreThreshold: 0.2,
        hardBlockedTaskClasses: ["wallet_transfer"],
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("hard_blocked_task_class");
    expect(decision.diagnostics.hasHardBlockedTaskClass).toBe(true);
  });

  it("requires explicit planner confidence threshold for handoff mode", () => {
    const decision = assessDelegationDecision({
      messageText: "Decompose this investigation and hand off execution.",
      plannerConfidence: 0.55,
      complexityScore: 9,
      totalSteps: 3,
      synthesisSteps: 1,
      edges: [],
      subagentSteps: [
        {
          name: "delegate_a",
          acceptanceCriteria: ["collect evidence"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
        {
          name: "delegate_b",
          acceptanceCriteria: ["correlate findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["test_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
      ],
      config: {
        enabled: true,
        mode: "handoff",
        handoffMinPlannerConfidence: 0.8,
        scoreThreshold: 0.2,
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("handoff_confidence_below_threshold");
  });
});
