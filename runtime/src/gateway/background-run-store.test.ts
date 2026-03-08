import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { AGENT_RUN_SCHEMA_VERSION } from "./agent-run-contract.js";
import {
  BackgroundRunStore,
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
      maxRuntimeMs: 604_800_000,
      maxCycles: 512,
      maxIdleMs: 3_600_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
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
      version: AGENT_RUN_SCHEMA_VERSION,
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
      blockerSummary: undefined,
      watchCount: 1,
      fenceToken: 2,
    });

    expect(await store.loadRecentSnapshot("session-1")).toEqual({
      version: AGENT_RUN_SCHEMA_VERSION,
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
      blockerSummary: undefined,
      watchCount: 1,
      fenceToken: 2,
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

    await expect(store.loadRun("session-1")).resolves.toMatchObject({
      version: AGENT_RUN_SCHEMA_VERSION,
      sessionId: "session-1",
      carryForward: expect.objectContaining({
        artifacts: [],
        memoryAnchors: [],
        summaryHealth: {
          status: "healthy",
          driftCount: 0,
        },
      }),
      budgetState: expect.objectContaining({
        maxRuntimeMs: 604_800_000,
        maxCycles: 512,
      }),
      compaction: expect.objectContaining({
        lastCompactedCycle: 1,
        repairCount: 0,
      }),
      approvalState: { status: "none" },
      watchRegistrations: [
        expect.objectContaining({
          id: "watch:managed_process:proc_watcher",
        }),
      ],
      fenceToken: 1,
    });
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
});
