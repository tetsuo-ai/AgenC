import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { AGENT_RUN_SCHEMA_VERSION } from "./agent-run-contract.js";
import {
  BackgroundRunStore,
  type PersistedBackgroundRun,
} from "./background-run-store.js";
import { BackgroundRunWakeBus } from "./background-run-wake-bus.js";

function makeRun(
  overrides: Partial<PersistedBackgroundRun> = {},
): PersistedBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: "bg-test",
    sessionId: "session-1",
    objective: "Monitor a process until it completes.",
    contract: {
      domain: "generic",
      kind: "until_condition",
      successCriteria: ["Verify the process is still running."],
      completionCriteria: ["Observe the terminal process state."],
      blockedCriteria: ["Missing process controls."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
    },
    state: "working",
    fenceToken: 1,
    createdAt: 1,
    updatedAt: 1,
    cycleCount: 1,
    stableWorkingCycles: 0,
    consecutiveErrorCycles: 0,
    nextCheckAt: 5_000,
    nextHeartbeatAt: 3_000,
    lastVerifiedAt: 1,
    lastUserUpdate: "Process is running.",
    lastToolEvidence: "desktop.process_status [ok] running",
    lastHeartbeatContent: undefined,
    lastWakeReason: "timer",
    carryForward: undefined,
    blocker: undefined,
    approvalState: { status: "none", requestedAt: undefined, summary: undefined },
    budgetState: {
      runtimeStartedAt: 1,
      lastActivityAt: 1,
      lastProgressAt: 1,
      maxRuntimeMs: 604_800_000,
      maxCycles: 512,
      maxIdleMs: 3_600_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
    },
    compaction: {
      lastCompactedAt: undefined,
      lastCompactedCycle: 0,
      refreshCount: 0,
      lastHistoryLength: 0,
      lastMilestoneAt: undefined,
      lastCompactionReason: undefined,
      repairCount: 0,
      lastProviderAnchorAt: undefined,
    },
    pendingSignals: [],
    observedTargets: [],
    watchRegistrations: [],
    internalHistory: [],
    leaseOwnerId: "instance-a",
    leaseExpiresAt: 10_000,
    ...overrides,
  };
}

describe("BackgroundRunWakeBus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it("dispatches immediate operator wakes and drains them into the run", async () => {
    const store = new BackgroundRunStore({
      memoryBackend: new InMemoryBackend(),
    });
    await store.saveRun(makeRun());
    const onWakeReady = vi.fn(async () => undefined);
    const wakeBus = new BackgroundRunWakeBus({
      runStore: store,
      onWakeReady,
      now: () => Date.now(),
    });

    await wakeBus.recoverSession("session-1");
    await wakeBus.enqueue({
      sessionId: "session-1",
      runId: "bg-test",
      type: "user_input",
      domain: "operator",
      content: "Wake up now.",
      createdAt: 1,
      availableAt: 1,
    });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(onWakeReady).toHaveBeenCalledWith("session-1");

    const drained = await wakeBus.drainDueWakeEvents("session-1");
    expect(drained.deliveredSignals).toEqual([
      expect.objectContaining({
        type: "user_input",
        content: "Wake up now.",
      }),
    ]);
    expect(drained.run?.pendingSignals).toHaveLength(1);
    expect(wakeBus.getQueuedCount("session-1")).toBe(0);
  });

  it("fires scheduled timer wakes with fake-clock control", async () => {
    const store = new BackgroundRunStore({
      memoryBackend: new InMemoryBackend(),
    });
    await store.saveRun(makeRun());
    const onWakeReady = vi.fn(async () => undefined);
    const wakeBus = new BackgroundRunWakeBus({
      runStore: store,
      onWakeReady,
      now: () => Date.now(),
    });

    await wakeBus.enqueue({
      sessionId: "session-1",
      runId: "bg-test",
      type: "timer",
      domain: "scheduler",
      content: "Scheduled timer wake.",
      createdAt: 10,
      availableAt: 5_000,
      dedupeKey: "scheduled:session-1:bg-test",
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onWakeReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(onWakeReady).toHaveBeenCalledTimes(1);
  });

  it("keeps operator and approval wakes ahead of noisy external events under load", async () => {
    const store = new BackgroundRunStore({
      memoryBackend: new InMemoryBackend(),
    });
    await store.saveRun(makeRun());
    const wakeBus = new BackgroundRunWakeBus({
      runStore: store,
      onWakeReady: async () => undefined,
      now: () => Date.now(),
      maxBatchSize: 4,
    });

    for (let index = 0; index < 50; index += 1) {
      await wakeBus.enqueue({
        sessionId: "session-1",
        type: "external_event",
        domain: "external",
        content: `Noisy external event ${index}`,
        createdAt: index,
        availableAt: 0,
      });
    }
    await wakeBus.enqueue({
      sessionId: "session-1",
      type: "user_input",
      domain: "operator",
      content: "Operator override.",
      createdAt: 100,
      availableAt: 0,
    });
    await wakeBus.enqueue({
      sessionId: "session-1",
      type: "approval",
      domain: "approval",
      content: "Approval granted.",
      createdAt: 101,
      availableAt: 0,
    });

    const drained = await wakeBus.drainDueWakeEvents("session-1");
    expect(drained.deliveredSignals.map((signal) => signal.type)).toEqual([
      "approval",
      "user_input",
      "external_event",
      "external_event",
    ]);
  });
});
