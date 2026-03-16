import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { AGENT_RUN_SCHEMA_VERSION } from "./agent-run-contract.js";
import {
  BackgroundRunStore,
  deriveDefaultBackgroundRunMaxCycles,
  type PersistedBackgroundRun,
} from "./background-run-store.js";

function makeRun(
  overrides: Partial<PersistedBackgroundRun> = {},
): PersistedBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: "bg-test",
    sessionId: "session-1",
    objective: "Monitor a process until it completes.",
    policyScope: {
      tenantId: "tenant-a",
      projectId: "project-x",
      runId: "run-bg-test",
    },
    contract: {
      domain: "managed_process",
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
    carryForward: {
      summary: "Watcher is running and still requires supervision.",
      verifiedFacts: ["Watcher process is running."],
      openLoops: ["Wait for the terminal process state."],
      nextFocus: "Check process state again.",
      artifacts: [],
      memoryAnchors: [],
      providerContinuation: undefined,
      summaryHealth: {
        status: "healthy",
        driftCount: 0,
      },
      lastCompactedAt: 1,
    },
    blocker: undefined,
    approvalState: { status: "none", requestedAt: undefined, summary: undefined },
    budgetState: {
      runtimeStartedAt: 1,
      lastActivityAt: 1,
      lastProgressAt: 1,
      totalTokens: 8,
      lastCycleTokens: 3,
      managedProcessCount: 1,
      maxRuntimeMs: 604_800_000,
      maxCycles: 512,
      maxIdleMs: 3_600_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: 2,
      firstVerifiedUpdateAt: 3,
      stopRequestedAt: undefined,
    },
    compaction: {
      lastCompactedAt: 1,
      lastCompactedCycle: 1,
      refreshCount: 1,
      lastHistoryLength: 0,
      lastMilestoneAt: 1,
      lastCompactionReason: "milestone",
      repairCount: 0,
      lastProviderAnchorAt: undefined,
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
        exitCode: undefined,
        signal: undefined,
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
    watchRegistrations: [
      {
        id: "watch:managed_process:proc_watcher",
        kind: "managed_process",
        targetId: "proc_watcher",
        label: "watcher",
        wakeOn: ["process_exit", "tool_result"],
        registeredAt: 1,
        lastTriggeredAt: undefined,
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
    await store.heartbeatWorker({
      workerId: "instance-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 1_000,
    });

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

  it("allows another worker to steal a lease when the owner heartbeat is stale", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun({
      leaseOwnerId: "instance-a",
      leaseExpiresAt: 40_000,
    });

    await store.saveRun(run);
    await store.heartbeatWorker({
      workerId: "instance-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 1_000,
    });
    await store.heartbeatWorker({
      workerId: "instance-b",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 25_000,
    });

    const claimed = await store.claimLease(run.sessionId, "instance-b", 25_000);
    expect(claimed.claimed).toBe(true);
    expect(claimed.run?.leaseOwnerId).toBe("instance-b");
    expect(claimed.run?.leaseExpiresAt).toBeGreaterThan(25_000);
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
      version: AGENT_RUN_SCHEMA_VERSION,
      runId: "bg-test",
      sessionId: "session-1",
      objective: "Monitor the process until it exits.",
      policyScope: {
        tenantId: "tenant-a",
        projectId: "project-x",
        runId: "run-bg-test",
      },
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
      blockerSummary: undefined,
      watchCount: 1,
      fenceToken: 2,
    });

    expect(await store.loadRecentSnapshot("session-1")).toEqual({
      version: AGENT_RUN_SCHEMA_VERSION,
      runId: "bg-test",
      sessionId: "session-1",
      objective: "Monitor the process until it exits.",
      policyScope: {
        tenantId: "tenant-a",
        projectId: "project-x",
        runId: "run-bg-test",
      },
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
      blockerSummary: undefined,
      watchCount: 1,
      fenceToken: 2,
    });
  });

  it("stores, reloads, and deletes terminal checkpoints for retry", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun({
      state: "completed",
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      lastWakeReason: "process_exit",
    });

    await store.saveCheckpoint(run);
    expect(await store.loadCheckpoint(run.sessionId)).toEqual(run);

    await store.deleteCheckpoint(run.sessionId);
    expect(await store.loadCheckpoint(run.sessionId)).toBeUndefined();
  });

  it("persists policy scope and extended budget counters across reload", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun({
      budgetState: {
        runtimeStartedAt: 1,
        lastActivityAt: 5,
        lastProgressAt: 8,
        totalTokens: 21,
        lastCycleTokens: 13,
        managedProcessCount: 2,
        maxRuntimeMs: 500_000,
        maxCycles: 64,
        maxIdleMs: 30_000,
        nextCheckIntervalMs: 4_000,
        heartbeatIntervalMs: 12_000,
        firstAcknowledgedAt: 2,
        firstVerifiedUpdateAt: 9,
        stopRequestedAt: 10,
      },
    });

    await store.saveRun(run);

    const reloaded = await store.loadRun(run.sessionId);
    expect(reloaded?.policyScope).toEqual({
      tenantId: "tenant-a",
      projectId: "project-x",
      runId: "run-bg-test",
    });
    expect(reloaded?.budgetState).toMatchObject({
      totalTokens: 21,
      lastCycleTokens: 13,
      managedProcessCount: 2,
      firstAcknowledgedAt: 2,
      firstVerifiedUpdateAt: 9,
      stopRequestedAt: 10,
    });
  });

  it("accepts suspended runs and rejects invalid persisted records", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    const suspendedRun = makeRun({
      state: "suspended",
      nextCheckAt: 9_000,
      nextHeartbeatAt: undefined,
      lastWakeReason: "daemon_shutdown",
    });

    await store.saveRun(suspendedRun);
    expect(await store.loadRun(suspendedRun.sessionId)).toEqual(suspendedRun);

    await expect(
      store.saveRun({
        ...suspendedRun,
        contract: {
          ...suspendedRun.contract,
          successCriteria: [],
        },
      }),
    ).rejects.toThrow("Invalid persisted BackgroundRun record");
  });

  it("migrates schema version 1 records to the current durable run shape", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const legacyRun = {
      ...makeRun(),
      version: 1,
    };
    delete (legacyRun as any).budgetState;
    delete (legacyRun as any).compaction;
    delete (legacyRun as any).approvalState;
    delete (legacyRun as any).watchRegistrations;
    delete (legacyRun as any).fenceToken;

    await backend.set("background-run:session:session-1", legacyRun);

    const migrated = await store.loadRun("session-1");
    expect(migrated).toBeDefined();
    expect(migrated!.version).toBe(AGENT_RUN_SCHEMA_VERSION);
    expect(migrated!.sessionId).toBe("session-1");
    expect(migrated!.carryForward?.artifacts).toEqual([]);
    expect(migrated!.carryForward?.memoryAnchors).toEqual([]);
    expect(migrated!.carryForward?.summaryHealth).toEqual({
      status: "healthy",
      driftCount: 0,
    });
    expect(migrated!.budgetState.maxRuntimeMs).toBe(604_800_000);
    expect(migrated!.budgetState.maxCycles).toBe(
      deriveDefaultBackgroundRunMaxCycles({
        maxRuntimeMs: 604_800_000,
        nextCheckMs: 4_000,
      }),
    );
    expect(migrated!.compaction.lastCompactedCycle).toBe(1);
    expect(migrated!.compaction.repairCount).toBe(0);
    expect(migrated!.approvalState.status).toBe("none");
    expect(migrated!.watchRegistrations[0]?.id).toBe(
      "watch:managed_process:proc_watcher",
    );
    expect(migrated!.fenceToken).toBe(1);
  });

  it("scales default cycle budgets to the runtime budget instead of a fixed short cap", () => {
    expect(
      deriveDefaultBackgroundRunMaxCycles({
        maxRuntimeMs: 7 * 24 * 60 * 60_000,
        nextCheckMs: 8_000,
      }),
    ).toBeGreaterThan(512);
  });

  it("quarantines corrupt persisted records instead of surfacing partial state", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await backend.set("background-run:session:broken", {
      version: AGENT_RUN_SCHEMA_VERSION,
      id: "bg-broken",
      sessionId: "broken",
      state: "working",
      objective: "broken",
    });

    await expect(store.loadRun("broken")).resolves.toBeUndefined();
    await expect(store.listCorruptRunKeys()).resolves.toEqual([
      "background-run:corrupt:broken",
    ]);
  });

  it("rejects stale fence-token writes after another owner takes the lease", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun();

    await store.saveRun(run);
    const claimed = await store.claimLease(run.sessionId, "instance-b", 11_000);
    expect(claimed.claimed).toBe(true);
    expect(claimed.run?.fenceToken).toBe(2);

    await expect(store.saveRun(run)).rejects.toThrow(
      "Stale BackgroundRun fence token 1; current token is 2",
    );
  });

  it("accepts forward fence-token writes for the same lease owner", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const run = makeRun({
      leaseOwnerId: "instance-a",
      leaseExpiresAt: 20_000,
    });

    await store.saveRun(run);
    await store.saveRun({
      ...run,
      fenceToken: 2,
      updatedAt: 5_000,
      lastUserUpdate: "Forward progress persisted.",
    });

    await expect(store.loadRun(run.sessionId)).resolves.toMatchObject({
      fenceToken: 2,
      leaseOwnerId: "instance-a",
      lastUserUpdate: "Forward progress persisted.",
    });
  });

  it("garbage collects expired leases, terminal snapshots, and old corrupt records", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.saveRun(makeRun({
      sessionId: "lease-expired",
      leaseOwnerId: "instance-a",
      leaseExpiresAt: 5_000,
    }));
    await store.saveRecentSnapshot({
      version: AGENT_RUN_SCHEMA_VERSION,
      runId: "bg-terminal",
      sessionId: "terminal",
      objective: "Done",
      state: "completed",
      contractKind: "finite",
      requiresUserStop: false,
      cycleCount: 1,
      createdAt: 1,
      updatedAt: 1,
      lastVerifiedAt: 1,
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      lastUserUpdate: "Done.",
      lastToolEvidence: undefined,
      lastWakeReason: "timer",
      pendingSignals: 0,
      carryForwardSummary: undefined,
      blockerSummary: undefined,
      watchCount: 0,
      fenceToken: 1,
    });
    await backend.set("background-run:corrupt:old", {
      quarantinedAt: 1,
      reason: "bad json",
    });

    await expect(
      store.garbageCollect({
        now: 10_000,
        terminalSnapshotRetentionMs: 5_000,
        corruptRecordRetentionMs: 5_000,
      }),
    ).resolves.toEqual({
      releasedExpiredLeases: 1,
      deletedTerminalSnapshots: 1,
      deletedCorruptRecords: 1,
      deletedWakeDeadLetters: 0,
      deletedDispatchDeadLetters: 0,
      deletedStaleWorkers: 0,
      releasedExpiredDispatchClaims: 0,
    });

    await expect(store.loadRun("lease-expired")).resolves.toMatchObject({
      leaseOwnerId: undefined,
      leaseExpiresAt: undefined,
    });
    await expect(store.loadRecentSnapshot("terminal")).resolves.toBeUndefined();
    await expect(store.listCorruptRunKeys()).resolves.toEqual([]);
  });

  it("dedupes scheduled wake events by key and keeps only the latest schedule", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.enqueueWakeEvent({
      sessionId: "session-1",
      runId: "bg-test",
      type: "timer",
      domain: "scheduler",
      content: "Timer wake",
      createdAt: 1,
      availableAt: 5_000,
      dedupeKey: "scheduled:session-1:bg-test",
    });
    await store.enqueueWakeEvent({
      sessionId: "session-1",
      runId: "bg-test",
      type: "busy_retry",
      domain: "scheduler",
      content: "Busy retry wake",
      createdAt: 2,
      availableAt: 3_000,
      dedupeKey: "scheduled:session-1:bg-test",
    });

    const queue = await store.loadWakeQueue("session-1");
    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]).toMatchObject({
      type: "busy_retry",
      content: "Busy retry wake",
      availableAt: 3_000,
    });
  });

  it("delivers due wake events to the run in priority order", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    await store.saveRun(makeRun());

    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "external_event",
      domain: "external",
      content: "Webhook warning",
      createdAt: 1,
      availableAt: 1,
    });
    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "user_input",
      domain: "operator",
      content: "Please prioritize this instruction.",
      createdAt: 2,
      availableAt: 1,
    });
    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "approval",
      domain: "approval",
      content: "Approval granted.",
      createdAt: 3,
      availableAt: 1,
    });

    const delivered = await store.deliverDueWakeEventsToRun({
      sessionId: "session-1",
      now: 10,
    });

    expect(delivered.deliveredSignals.map((signal) => signal.type)).toEqual([
      "approval",
      "user_input",
      "external_event",
    ]);
    expect(delivered.remainingQueuedEvents).toBe(0);
    expect(delivered.run?.pendingSignals.map((signal) => signal.type)).toEqual([
      "approval",
      "user_input",
      "external_event",
    ]);
  });

  it("moves exhausted wake events into dead letters instead of delivering them forever", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    await store.saveRun(makeRun());
    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "user_input",
      domain: "operator",
      content: "Retry budget exhausted.",
      createdAt: 1,
      availableAt: 1,
      maxDeliveryAttempts: 1,
    });

    const delivered = await store.deliverDueWakeEventsToRun({
      sessionId: "session-1",
      now: 10,
    });

    expect(delivered.deliveredSignals).toEqual([]);
    await expect(store.listWakeDeadLetters("session-1")).resolves.toEqual([
      expect.objectContaining({
        reason: "wake_delivery_attempts_exhausted",
        event: expect.objectContaining({
          type: "user_input",
          content: "Retry budget exhausted.",
        }),
      }),
    ]);
  });

  it("handles out-of-order wake insertion by delivering the earliest due event first", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    await store.saveRun(makeRun());

    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "external_event",
      domain: "external",
      content: "Later event inserted first.",
      createdAt: 10,
      availableAt: 20,
    });
    await store.enqueueWakeEvent({
      sessionId: "session-1",
      type: "user_input",
      domain: "operator",
      content: "Earlier event inserted second.",
      createdAt: 11,
      availableAt: 5,
    });

    const firstBatch = await store.deliverDueWakeEventsToRun({
      sessionId: "session-1",
      now: 5,
      limit: 1,
    });
    expect(firstBatch.deliveredSignals).toEqual([
      expect.objectContaining({
        type: "user_input",
        content: "Earlier event inserted second.",
      }),
    ]);

    const secondBatch = await store.deliverDueWakeEventsToRun({
      sessionId: "session-1",
      now: 20,
      limit: 1,
    });
    expect(secondBatch.deliveredSignals).toEqual([
      expect.objectContaining({
        type: "external_event",
        content: "Later event inserted first.",
      }),
    ]);
  });

  it("round-trips typed domain contracts and signal payloads for non-process domains", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const fixtures: readonly PersistedBackgroundRun[] = [
      makeRun({
        id: "bg-browser",
        sessionId: "session-browser",
        objective: "Download the report from the browser session.",
        contract: {
          domain: "browser",
          kind: "finite",
          successCriteria: ["Download the report artifact."],
          completionCriteria: ["Observe the report download completing."],
          blockedCriteria: ["Browser automation fails."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        pendingSignals: [
          {
            id: "sig-browser",
            type: "tool_result",
            content: "Browser download completed at /tmp/report.pdf.",
            timestamp: 10,
            data: {
              category: "browser",
              toolName: "mcp.browser.browser_download",
              artifactPath: "/tmp/report.pdf",
              failed: false,
            },
          },
        ],
        observedTargets: [],
        watchRegistrations: [],
      }),
      makeRun({
        id: "bg-workspace",
        sessionId: "session-workspace",
        objective: "Run the workspace test suite successfully.",
        contract: {
          domain: "workspace",
          kind: "finite",
          successCriteria: ["Execute the workspace tests."],
          completionCriteria: ["Verify the test command succeeds."],
          blockedCriteria: ["Workspace tooling is missing."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        pendingSignals: [
          {
            id: "sig-workspace",
            type: "tool_result",
            content: "Tool result observed for system.bash.",
            timestamp: 11,
            data: {
              category: "generic",
              toolName: "system.bash",
              command: "npm",
              failed: false,
            },
          },
        ],
        observedTargets: [],
        watchRegistrations: [],
      }),
      makeRun({
        id: "bg-research",
        sessionId: "session-research",
        objective: "Research the vendor and save a short report.",
        contract: {
          domain: "research",
          kind: "finite",
          successCriteria: ["Produce the report artifact."],
          completionCriteria: ["Persist the report to disk."],
          blockedCriteria: ["Research tools fail."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        pendingSignals: [
          {
            id: "sig-research",
            type: "webhook",
            content: "Artifact watcher saved the research report.",
            timestamp: 12,
            data: {
              source: "artifact-watcher",
              path: "/tmp/research-report.md",
            },
          },
        ],
        observedTargets: [],
        watchRegistrations: [],
      }),
      makeRun({
        id: "bg-pipeline",
        sessionId: "session-pipeline",
        objective: "Wait for the workflow to become healthy.",
        contract: {
          domain: "pipeline",
          kind: "until_condition",
          successCriteria: ["Observe healthy workflow state."],
          completionCriteria: ["See a healthy pipeline transition."],
          blockedCriteria: ["Pipeline health fails."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        pendingSignals: [
          {
            id: "sig-pipeline",
            type: "external_event",
            content: "Service health event server.health for http://localhost:8080 (healthy).",
            timestamp: 13,
            data: {
              eventType: "server.health",
              state: "healthy",
              status: 200,
            },
          },
        ],
        observedTargets: [],
        watchRegistrations: [],
      }),
      makeRun({
        id: "bg-remote-mcp",
        sessionId: "session-remote-mcp",
        objective: "Wait for the remote MCP job to finish.",
        contract: {
          domain: "remote_mcp",
          kind: "finite",
          successCriteria: ["Observe the remote MCP job complete."],
          completionCriteria: ["Receive a completion event from the remote server."],
          blockedCriteria: ["Remote MCP job fails."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        pendingSignals: [
          {
            id: "sig-remote-mcp",
            type: "tool_result",
            content: "MCP event observed from remote-job-server (job-42) completed successfully.",
            timestamp: 14,
            data: {
              category: "mcp",
              serverName: "remote-job-server",
              jobId: "job-42",
              state: "completed",
              failed: false,
            },
          },
        ],
        observedTargets: [],
        watchRegistrations: [],
      }),
      makeRun({
        id: "bg-approval",
        sessionId: "session-approval",
        objective: "Wait for operator approval.",
        contract: {
          domain: "approval",
          kind: "until_condition",
          successCriteria: ["Resume after approval."],
          completionCriteria: ["Observe the approval signal."],
          blockedCriteria: ["Approval is still pending."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
        },
        state: "blocked",
        blocker: {
          code: "approval_required",
          summary: "Waiting for operator approval.",
          since: 15,
          requiresOperatorAction: true,
          requiresApproval: true,
          retryable: true,
        },
        approvalState: {
          status: "waiting",
          requestedAt: 15,
          summary: "Waiting for operator approval.",
        },
        pendingSignals: [],
        observedTargets: [],
        watchRegistrations: [],
      }),
    ];

    for (const fixture of fixtures) {
      await store.saveRun(fixture);
    }

    for (const fixture of fixtures) {
      await expect(store.loadRun(fixture.sessionId)).resolves.toMatchObject({
        contract: expect.objectContaining({
          domain: fixture.contract.domain,
        }),
        pendingSignals: fixture.pendingSignals,
        approvalState: fixture.approvalState,
      });
    }
  });

  it("claims durable dispatch items by worker pool and preserves preferred-worker affinity", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.heartbeatWorker({
      workerId: "worker-browser",
      pools: ["browser"],
      maxConcurrentRuns: 1,
      now: 1,
    });
    await store.heartbeatWorker({
      workerId: "worker-generic",
      pools: ["generic", "code"],
      maxConcurrentRuns: 1,
      now: 1,
    });

    await store.enqueueDispatch({
      sessionId: "session-browser",
      runId: "bg-browser",
      pool: "browser",
      reason: "start",
      createdAt: 2,
      availableAt: 2,
      dedupeKey: "dispatch:bg-browser:start",
      preferredWorkerId: "worker-browser",
    });

    const genericClaim = await store.claimDispatchForWorker({
      workerId: "worker-generic",
      pools: ["generic", "code"],
      now: 2,
    });
    expect(genericClaim.claimed).toBe(false);

    const browserClaim = await store.claimDispatchForWorker({
      workerId: "worker-browser",
      pools: ["browser"],
      now: 2,
    });
    expect(browserClaim).toMatchObject({
      claimed: true,
      item: expect.objectContaining({
        sessionId: "session-browser",
        pool: "browser",
        preferredWorkerId: "worker-browser",
        claimOwnerId: "worker-browser",
      }),
    });
  });

  it("allows another worker to reclaim a dispatch item when the claim owner heartbeat is stale", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 1_000,
    });
    await store.heartbeatWorker({
      workerId: "worker-b",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 25_000,
    });

    await store.enqueueDispatch({
      sessionId: "session-stale-claim",
      runId: "bg-stale-claim",
      pool: "generic",
      reason: "timer",
      createdAt: 1_000,
      availableAt: 1_000,
      dedupeKey: "dispatch:stale-claim",
    });

    const firstClaim = await store.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 1_500,
    });
    expect(firstClaim.claimed).toBe(true);
    expect(firstClaim.item?.claimOwnerId).toBe("worker-a");
    expect(firstClaim.item?.claimExpiresAt).toBeGreaterThan(25_000);

    const recoveredClaim = await store.claimDispatchForWorker({
      workerId: "worker-b",
      pools: ["generic"],
      now: 25_000,
    });
    expect(recoveredClaim.claimed).toBe(true);
    expect(recoveredClaim.item?.claimOwnerId).toBe("worker-b");
  });

  it("supports worker drain state and releases expired dispatch claims during garbage collection", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 1,
    });
    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "timer",
      createdAt: 2,
      availableAt: 2,
      dedupeKey: "dispatch:bg-test:timer",
    });
    const claimed = await store.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 2,
    });
    expect(claimed.claimed).toBe(true);

    const drained = await store.setWorkerDrainState({
      workerId: "worker-a",
      draining: true,
      now: 3,
    });
    expect(drained?.state).toBe("draining");

    await expect(
      store.garbageCollect({
        now: 100_000,
      }),
    ).resolves.toMatchObject({
      releasedExpiredDispatchClaims: 1,
      deletedStaleWorkers: 1,
    });

    const stats = await store.getDispatchStats();
    expect(stats.totalQueued).toBe(1);
    expect(stats.totalClaimed).toBe(0);
  });

  it("dedupes durable dispatch items by key and updates the latest availability", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "timer",
      createdAt: 1,
      availableAt: 10,
      dedupeKey: "dispatch:bg-test:timer",
    });
    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "busy_retry",
      createdAt: 2,
      availableAt: 5,
      dedupeKey: "dispatch:bg-test:timer",
    });

    await store.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 3,
    });

    const claim = await store.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 5,
    });
    expect(claim.item).toMatchObject({
      reason: "busy_retry",
      availableAt: 5,
    });
  });

  it("prunes redundant queued dispatches for the same session while preserving the claimed item", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    await store.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 1,
    });

    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "timer",
      createdAt: 1,
      availableAt: 1,
      dedupeKey: "dispatch:bg-test:timer",
    });
    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "user_input",
      createdAt: 2,
      availableAt: 2,
      dedupeKey: "dispatch:bg-test:user_input",
    });
    await store.enqueueDispatch({
      sessionId: "session-2",
      runId: "bg-test-2",
      pool: "generic",
      reason: "timer",
      createdAt: 3,
      availableAt: 3,
      dedupeKey: "dispatch:bg-test-2:timer",
    });

    const claimed = await store.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 1,
    });
    expect(claimed.claimed).toBe(true);
    expect(claimed.item?.sessionId).toBe("session-1");

    const pruned = await store.pruneDispatchesForSession({
      sessionId: "session-1",
      excludeDispatchId: claimed.item?.id,
      now: 4,
    });
    expect(pruned).toEqual({
      removedCount: 1,
      queueDepth: 2,
    });

    await store.completeDispatch({
      dispatchId: claimed.item!.id,
      workerId: "worker-a",
      now: 5,
    });
    await expect(store.getDispatchStats()).resolves.toMatchObject({
      totalQueued: 1,
      totalClaimed: 0,
    });
  });

  it("maintains a lightweight dispatch beacon as queue state changes", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });

    expect(await store.loadDispatchBeacon()).toMatchObject({
      revision: 0,
      queueDepth: 0,
    });
    expect((await store.loadDispatchBeacon()).nextAvailableAt).toBeUndefined();

    await store.enqueueDispatch({
      sessionId: "session-1",
      runId: "bg-test",
      pool: "generic",
      reason: "timer",
      createdAt: 1,
      availableAt: 10,
      dedupeKey: "dispatch:bg-test:timer",
    });
    expect(await store.loadDispatchBeacon()).toMatchObject({
      revision: 1,
      queueDepth: 1,
      nextAvailableAt: 10,
    });

    await store.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 2,
    });
    await store.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 10,
    });
    expect(await store.loadDispatchBeacon()).toMatchObject({
      revision: 2,
      queueDepth: 1,
      nextAvailableAt: 10,
    });

    await store.completeDispatch({
      dispatchId: "dispatch-1-0",
      workerId: "worker-a",
      now: 11,
    });
    expect(await store.loadDispatchBeacon()).toMatchObject({
      revision: 3,
      queueDepth: 0,
      nextAvailableAt: undefined,
    });
  });

  it("holds up under concurrent dispatch-claim load across multiple workers", async () => {
    const backend = new InMemoryBackend();
    const store = new BackgroundRunStore({ memoryBackend: backend });
    const totalItems = 48;

    await Promise.all([
      store.heartbeatWorker({
        workerId: "worker-a",
        pools: ["generic"],
        maxConcurrentRuns: 1,
        now: 1,
      }),
      store.heartbeatWorker({
        workerId: "worker-b",
        pools: ["generic"],
        maxConcurrentRuns: 1,
        now: 1,
      }),
      store.heartbeatWorker({
        workerId: "worker-c",
        pools: ["generic"],
        maxConcurrentRuns: 1,
        now: 1,
      }),
    ]);

    await Promise.all(
      Array.from({ length: totalItems }, (_, index) =>
        store.enqueueDispatch({
          sessionId: `session-${index}`,
          runId: `bg-${index}`,
          pool: "generic",
          reason: "start",
          createdAt: index + 2,
          availableAt: 2,
          dedupeKey: `dispatch:bg-${index}:start`,
        }),
      ),
    );

    const claimedIds = new Set<string>();
    const consume = async (workerId: string) => {
      while (true) {
        const claim = await store.claimDispatchForWorker({
          workerId,
          pools: ["generic"],
          now: 2,
        });
        if (!claim.claimed || !claim.item) {
          return;
        }
        expect(claimedIds.has(claim.item.id)).toBe(false);
        claimedIds.add(claim.item.id);
        await store.completeDispatch({
          dispatchId: claim.item.id,
          workerId,
          now: 2,
        });
      }
    };

    await Promise.all([
      consume("worker-a"),
      consume("worker-b"),
      consume("worker-c"),
    ]);

    expect(claimedIds.size).toBe(totalItems);
    await expect(store.getDispatchStats()).resolves.toMatchObject({
      totalQueued: 0,
      totalClaimed: 0,
    });
  });
});
