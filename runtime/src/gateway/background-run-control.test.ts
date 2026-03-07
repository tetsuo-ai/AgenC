import { describe, expect, it } from "vitest";
import {
  formatBackgroundRunStatus,
  formatInactiveBackgroundRunStatus,
  formatInactiveBackgroundRunStop,
} from "./background-run-control.js";
import type { BackgroundRunRecentSnapshot } from "./background-run-store.js";
import type { BackgroundRunStatusSnapshot } from "./background-run-supervisor.js";

function makeActiveSnapshot(
  overrides: Partial<BackgroundRunStatusSnapshot> = {},
): BackgroundRunStatusSnapshot {
  return {
    id: "bg_123",
    sessionId: "session-1",
    objective: "Monitor the process.",
    state: "working",
    cycleCount: 3,
    createdAt: 1_000,
    updatedAt: 11_000,
    lastVerifiedAt: 9_000,
    nextCheckAt: 15_000,
    nextHeartbeatAt: 13_000,
    lastUserUpdate: "Process is still running.",
    lastWakeReason: "timer",
    pendingSignals: 1,
    carryForwardSummary: "Waiting for exit.",
    ...overrides,
  };
}

function makeRecentSnapshot(
  overrides: Partial<BackgroundRunRecentSnapshot> = {},
): BackgroundRunRecentSnapshot {
  return {
    version: 1,
    runId: "bg_123",
    sessionId: "session-1",
    objective: "Monitor the process.",
    state: "completed",
    contractKind: "until_condition",
    requiresUserStop: false,
    cycleCount: 4,
    createdAt: 1_000,
    updatedAt: 12_000,
    lastVerifiedAt: 11_000,
    nextCheckAt: undefined,
    nextHeartbeatAt: undefined,
    lastUserUpdate: "Process exited cleanly.",
    lastToolEvidence: "desktop.process_status [ok] exited",
    lastWakeReason: "process_exit",
    pendingSignals: 0,
    carryForwardSummary: "Process observed exited.",
    ...overrides,
  };
}

describe("background-run-control", () => {
  it("formats active background run status deterministically", () => {
    const message = formatBackgroundRunStatus(makeActiveSnapshot(), 12_000);

    expect(message).toContain("Background run: working");
    expect(message).toContain("Objective: Monitor the process.");
    expect(message).toContain("Cycles: 3");
    expect(message).toContain("Last verified: ~3s ago");
    expect(message).toContain("Latest update: Process is still running.");
    expect(message).toContain("Pending signals: 1");
    expect(message).toContain("Next heartbeat: ~1s");
    expect(message).toContain("Next check: ~3s");
  });

  it("formats inactive status replies from the recent snapshot", () => {
    const message = formatInactiveBackgroundRunStatus(makeRecentSnapshot(), 15_000);

    expect(message).toContain("No active background run for this session.");
    expect(message).toContain("Last run: completed");
    expect(message).toContain("Objective: Monitor the process.");
    expect(message).toContain("Last changed: ~3s ago");
    expect(message).toContain("Latest update: Process exited cleanly.");
  });

  it("formats inactive stop replies without invoking the model", () => {
    expect(formatInactiveBackgroundRunStop(undefined)).toBe(
      "No active background run to stop.",
    );

    const message = formatInactiveBackgroundRunStop(
      makeRecentSnapshot({ state: "failed" }),
      16_000,
    );
    expect(message).toContain("No active background run to stop.");
    expect(message).toContain("Last run: failed");
    expect(message).toContain("Last changed: ~4s ago");
  });
});
