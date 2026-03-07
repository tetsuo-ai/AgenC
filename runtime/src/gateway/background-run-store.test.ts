import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import {
  BackgroundRunStore,
  type PersistedBackgroundRun,
} from "./background-run-store.js";

function makeRun(
  overrides: Partial<PersistedBackgroundRun> = {},
): PersistedBackgroundRun {
  return {
    version: 1,
    id: "bg-test",
    sessionId: "session-1",
    objective: "Monitor a process until it completes.",
    contract: {
      kind: "until_condition",
      successCriteria: ["Verify the process is still running."],
      completionCriteria: ["Observe the terminal process state."],
      blockedCriteria: ["Missing process controls."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: {
        mode: "until_exit",
        maxRestarts: 3,
        restartBackoffMs: 2_000,
      },
    },
    state: "working",
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
    carryForward: {
      summary: "Watcher is running and still requires supervision.",
      verifiedFacts: ["Watcher process is running."],
      openLoops: ["Wait for the terminal process state."],
      nextFocus: "Check process state again.",
      lastCompactedAt: 1,
    },
    pendingSignals: [],
    observedTargets: [
      {
        kind: "managed_process",
        processId: "proc_watcher",
        label: "watcher",
        pid: 42,
        pgid: 42,
        desiredState: "exited",
        exitPolicy: "until_exit",
        currentState: "running",
        lastObservedAt: 1,
        launchSpec: {
          command: "/bin/sleep",
          args: ["2"],
          cwd: "/tmp",
          label: "watcher",
          logPath: "/tmp/agenc-processes/proc_watcher.log",
        },
        restartCount: 1,
        lastRestartAt: 2,
      },
    ],
    internalHistory: [],
    leaseOwnerId: "instance-a",
    leaseExpiresAt: 10_000,
    ...overrides,
  };
}

describe("BackgroundRunStore", () => {
  it("saves, lists, and deletes persisted runs", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun();

    await store.saveRun(run);

    expect(await store.loadRun(run.sessionId)).toEqual(run);
    expect(await store.listRuns()).toEqual([run]);

    await store.deleteRun(run.sessionId);

    expect(await store.loadRun(run.sessionId)).toBeUndefined();
    expect(await store.listRuns()).toEqual([]);
  });

  it("enforces lease ownership until the lease expires", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun();

    await store.saveRun(run);

    const foreignClaim = await store.claimLease(run.sessionId, "instance-b", 5_000);
    expect(foreignClaim.claimed).toBe(false);
    expect(foreignClaim.run?.leaseOwnerId).toBe("instance-a");

    const expiredClaim = await store.claimLease(run.sessionId, "instance-b", 11_000);
    expect(expiredClaim.claimed).toBe(true);
    expect(expiredClaim.run?.leaseOwnerId).toBe("instance-b");

    const released = await store.releaseLease(run.sessionId, "instance-b", 12_000, {
      ...expiredClaim.run!,
      state: "working",
      nextCheckAt: 15_000,
    });
    expect(released?.leaseOwnerId).toBeUndefined();
    expect(released?.nextCheckAt).toBe(15_000);
  });

  it("stores append-only run events in a dedicated thread", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun();

    await store.saveRun(run);
    await store.appendEvent(run, {
      type: "run_started",
      summary: "Background run started.",
      timestamp: 1,
      data: { phase: "start" },
    });
    await store.appendEvent(run, {
      type: "cycle_started",
      summary: "Cycle 1 started.",
      timestamp: 2,
      data: { cycle: 1 },
    });

    const events = await store.listEvents(run.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.content).toBe("Background run started.");
    expect(events[0]?.metadata).toMatchObject({
      backgroundRunId: run.id,
      eventType: "run_started",
      phase: "start",
    });
    expect(events[1]?.metadata).toMatchObject({
      eventType: "cycle_started",
      cycle: 1,
    });
  });

  it("stores and reloads the latest recent snapshot for a session", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.saveRecentSnapshot({
      version: 1,
      runId: "bg-test",
      sessionId: "session-1",
      objective: "Monitor the process until it exits.",
      state: "completed",
      contractKind: "until_condition",
      requiresUserStop: false,
      cycleCount: 2,
      createdAt: 1,
      updatedAt: 20,
      lastVerifiedAt: 18,
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      lastUserUpdate: "Process exited cleanly.",
      lastToolEvidence: "desktop.process_status [ok] exited",
      lastWakeReason: "process_exit",
      pendingSignals: 0,
      carryForwardSummary: "Observed terminal process exit.",
    });

    expect(await store.loadRecentSnapshot("session-1")).toEqual({
      version: 1,
      runId: "bg-test",
      sessionId: "session-1",
      objective: "Monitor the process until it exits.",
      state: "completed",
      contractKind: "until_condition",
      requiresUserStop: false,
      cycleCount: 2,
      createdAt: 1,
      updatedAt: 20,
      lastVerifiedAt: 18,
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      lastUserUpdate: "Process exited cleanly.",
      lastToolEvidence: "desktop.process_status [ok] exited",
      lastWakeReason: "process_exit",
      pendingSignals: 0,
      carryForwardSummary: "Observed terminal process exit.",
    });
  });
});
