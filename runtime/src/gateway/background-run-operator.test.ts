import { describe, expect, it } from "vitest";
import { buildBackgroundRunExplanation } from "./background-run-operator.js";

describe("background-run-operator", () => {
  it("explains approval waits as safe waiting states", () => {
    const explanation = buildBackgroundRunExplanation({
      state: "blocked",
      approval: {
        status: "waiting",
        requestId: "approval-1",
        summary: "Waiting for incident commander approval.",
        since: 1,
      },
      blocker: {
        summary: "Waiting for incident commander approval.",
        retryable: true,
        requiresApproval: true,
        requiresOperatorAction: true,
      },
      requiresUserStop: false,
      now: 10,
    });

    expect(explanation).toEqual({
      currentPhase: "waiting_approval",
      explanation: "Waiting for incident commander approval.",
      unsafeToContinue: false,
    });
  });

  it("marks failed runs as unsafe and paused runs as safe", () => {
    expect(
      buildBackgroundRunExplanation({
        state: "paused",
        approval: { status: "none" },
        requiresUserStop: false,
        now: 10,
      }),
    ).toEqual({
      currentPhase: "paused",
      explanation:
        "Run is paused by an operator and will not make progress until resumed.",
      unsafeToContinue: false,
    });

    expect(
      buildBackgroundRunExplanation({
        state: "failed",
        approval: { status: "none" },
        blocker: {
          summary: "Verifier rejected the run output.",
          retryable: false,
          requiresOperatorAction: true,
        },
        requiresUserStop: false,
        now: 10,
      }),
    ).toEqual({
      currentPhase: "failed",
      explanation: "Verifier rejected the run output.",
      unsafeToContinue: true,
    });
  });

  it("includes the next verification cadence for active runs", () => {
    const explanation = buildBackgroundRunExplanation({
      state: "working",
      approval: { status: "none" },
      nextCheckAt: 9_000,
      requiresUserStop: true,
      now: 5_100,
    });

    expect(explanation.currentPhase).toBe("active");
    expect(explanation.unsafeToContinue).toBe(false);
    expect(explanation.explanation).toContain(
      "Run is active and will continue until explicitly stopped.",
    );
    expect(explanation.explanation).toContain("Next verification in ~4s.");
  });
});
