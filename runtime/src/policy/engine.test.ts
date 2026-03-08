import { describe, it, expect } from "vitest";
import { PolicyEngine } from "./engine.js";
import { PolicyViolationError } from "./types.js";

describe("PolicyEngine", () => {
  it("allows everything when policy is disabled", () => {
    const engine = new PolicyEngine({
      policy: { enabled: false },
    });

    const decision = engine.evaluate({
      type: "tool_call",
      name: "agenc.createTask",
      access: "write",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
  });

  it("blocks denied tools deterministically", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        toolDenyList: ["agenc.createTask"],
      },
    });

    const decision = engine.evaluate({
      type: "tool_call",
      name: "agenc.createTask",
      access: "write",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0].code).toBe("tool_denied");
  });

  it("enforces action budgets", () => {
    let nowMs = 1_000;
    const engine = new PolicyEngine({
      now: () => nowMs,
      policy: {
        enabled: true,
        actionBudgets: {
          "task_execution:*": {
            limit: 1,
            windowMs: 10_000,
          },
        },
      },
    });

    const first = engine.evaluate({
      type: "task_execution",
      name: "execute_task",
      access: "write",
    });
    expect(first.allowed).toBe(true);

    const second = engine.evaluate({
      type: "task_execution",
      name: "execute_task",
      access: "write",
    });
    expect(second.allowed).toBe(false);
    expect(second.violations[0].code).toBe("action_budget_exceeded");

    nowMs += 11_000;
    const third = engine.evaluate({
      type: "task_execution",
      name: "execute_task",
      access: "write",
    });
    expect(third.allowed).toBe(true);
  });

  it("enforces spend budgets", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        spendBudget: {
          limitLamports: 1_000n,
          windowMs: 60_000,
        },
      },
    });

    const first = engine.evaluate({
      type: "tx_submission",
      name: "complete_task_submission",
      access: "write",
      spendLamports: 700n,
    });
    expect(first.allowed).toBe(true);

    const second = engine.evaluate({
      type: "tx_submission",
      name: "complete_task_submission",
      access: "write",
      spendLamports: 400n,
    });
    expect(second.allowed).toBe(false);
    expect(second.violations[0].code).toBe("spend_budget_exceeded");
  });

  it("auto-trips circuit breaker on repeated violations", () => {
    let nowMs = 1_000;
    const engine = new PolicyEngine({
      now: () => nowMs,
      policy: {
        enabled: true,
        denyActions: ["execute_task"],
        circuitBreaker: {
          enabled: true,
          threshold: 2,
          windowMs: 60_000,
          mode: "pause_discovery",
        },
      },
    });

    engine.evaluate({
      type: "task_execution",
      name: "execute_task",
      access: "write",
    });
    nowMs += 100;
    engine.evaluate({
      type: "task_execution",
      name: "execute_task",
      access: "write",
    });

    const state = engine.getState();
    expect(state.mode).toBe("pause_discovery");
    expect(state.circuitBreakerReason).toBe("auto_threshold");
  });

  it("safe mode allows reads but blocks writes", () => {
    const engine = new PolicyEngine({
      policy: { enabled: true },
    });
    engine.setMode("safe_mode", "manual-test");

    const readDecision = engine.evaluate({
      type: "tool_call",
      name: "agenc.listTasks",
      access: "read",
    });
    expect(readDecision.allowed).toBe(true);

    const writeDecision = engine.evaluate({
      type: "tool_call",
      name: "agenc.createTask",
      access: "write",
    });
    expect(writeDecision.allowed).toBe(false);
    expect(writeDecision.violations[0].code).toBe("circuit_breaker_active");
  });

  it("evaluateOrThrow throws structured violation errors", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        denyActions: ["execute_task"],
      },
    });

    expect(() =>
      engine.evaluateOrThrow({
        type: "task_execution",
        name: "execute_task",
        access: "write",
      }),
    ).toThrow(PolicyViolationError);
  });

  it("enforces tenant bundle tool denials", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        tenantBundles: {
          tenant_a: {
            enabled: true,
            toolDenyList: ["system.processStart"],
          },
        },
      },
    });

    const decision = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      scope: { tenantId: "tenant_a" },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0].code).toBe("tool_denied");
  });

  it("enforces run-scoped action budgets", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        scopedActionBudgets: {
          run: {
            "tool_call:*": {
              limit: 1,
              windowMs: 60_000,
            },
          },
        },
      },
    });

    const first = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      scope: { runId: "run-1" },
    });
    const second = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      scope: { runId: "run-1" },
    });
    const isolatedRun = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      scope: { runId: "run-2" },
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.violations[0].details).toMatchObject({ scope: "run" });
    expect(isolatedRun.allowed).toBe(true);
  });

  it("simulate does not consume action budgets", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        actionBudgets: {
          "tool_call:*": {
            limit: 1,
            windowMs: 60_000,
          },
        },
      },
    });

    const simulated = engine.simulate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
    });
    const firstReal = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
    });
    const secondReal = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
    });

    expect(simulated.allowed).toBe(true);
    expect(firstReal.allowed).toBe(true);
    expect(secondReal.allowed).toBe(false);
  });

  it("enforces rolling token budgets without consuming them in simulate mode", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        tokenBudget: {
          limitTokens: 10,
          windowMs: 60_000,
        },
      },
    });

    const simulated = engine.simulate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      tokenCount: 9,
    });
    const first = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      tokenCount: 9,
    });
    const second = engine.evaluate({
      type: "tool_call",
      name: "system.processStart",
      access: "write",
      tokenCount: 2,
    });

    expect(simulated.allowed).toBe(true);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.violations[0].code).toBe("token_budget_exceeded");
  });

  it("enforces run-scoped runtime budgets", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        scopedRuntimeBudgets: {
          run: {
            maxElapsedMs: 5_000,
          },
        },
      },
    });

    const allowed = engine.evaluate({
      type: "task_execution",
      name: "background_run.supervision",
      access: "write",
      scope: { runId: "run-1" },
      elapsedRuntimeMs: 4_000,
      elapsedRuntimeMsByScope: { run: 4_000 },
    });
    const denied = engine.evaluate({
      type: "task_execution",
      name: "background_run.supervision",
      access: "write",
      scope: { runId: "run-1" },
      elapsedRuntimeMs: 6_000,
      elapsedRuntimeMsByScope: { run: 6_000 },
    });

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
    expect(denied.violations[0].code).toBe("runtime_budget_exceeded");
    expect(denied.violations[0].details).toMatchObject({ scope: "run" });
  });

  it("enforces scoped process budgets from per-scope process counts", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        scopedProcessBudgets: {
          tenant: {
            maxConcurrent: 1,
          },
        },
      },
    });

    const decision = engine.evaluate({
      type: "task_execution",
      name: "background_run.supervision",
      access: "write",
      scope: { tenantId: "tenant-a", runId: "run-1" },
      processCount: 3,
      processCountByScope: {
        global: 3,
        tenant: 2,
        run: 1,
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0].code).toBe("process_budget_exceeded");
    expect(decision.violations[0].details).toMatchObject({
      scope: "tenant",
      observedConcurrent: 2,
      maxConcurrent: 1,
    });
  });

  it("blocks denied policy classes", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        policyClassRules: {
          credential_secret_access: {
            deny: true,
          },
        },
      },
    });

    const decision = engine.evaluate({
      type: "tool_call",
      name: "system.bash",
      access: "write",
      policyClass: "credential_secret_access",
      riskScore: 0.9,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0].code).toBe("policy_class_denied");
  });

  it("enforces network host allow-lists", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        networkAccess: {
          allowHosts: ["api.example.com"],
        },
      },
    });

    const allowed = engine.evaluate({
      type: "tool_call",
      name: "system.httpGet",
      access: "write",
      metadata: {
        networkHosts: ["api.example.com"],
      },
    });
    const denied = engine.evaluate({
      type: "tool_call",
      name: "system.httpGet",
      access: "write",
      metadata: {
        networkHosts: ["evil.example.com"],
      },
    });

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
    expect(denied.violations[0].code).toBe("network_access_denied");
  });

  it("enforces absolute write-scope roots", () => {
    const engine = new PolicyEngine({
      policy: {
        enabled: true,
        writeScope: {
          allowRoots: ["/srv/workspace"],
          denyRoots: ["/srv/workspace/secrets"],
        },
      },
    });

    const allowed = engine.evaluate({
      type: "tool_call",
      name: "system.writeFile",
      access: "write",
      metadata: {
        writePaths: ["/srv/workspace/output.txt"],
      },
    });
    const denied = engine.evaluate({
      type: "tool_call",
      name: "system.writeFile",
      access: "write",
      metadata: {
        writePaths: ["/srv/workspace/secrets/token.txt"],
      },
    });
    const relative = engine.evaluate({
      type: "tool_call",
      name: "system.writeFile",
      access: "write",
      metadata: {
        writePaths: ["relative/output.txt"],
      },
    });

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
    expect(denied.violations[0].code).toBe("write_scope_denied");
    expect(relative.allowed).toBe(false);
    expect(relative.violations[0].code).toBe("write_scope_denied");
  });
});
