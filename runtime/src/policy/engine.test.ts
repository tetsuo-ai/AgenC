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
});
