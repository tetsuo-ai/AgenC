import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import { AGENT_RUN_SCHEMA_VERSION } from "./agent-run-contract.js";
import { BackgroundRunStore, type PersistedBackgroundRun } from "./background-run-store.js";
import { BackgroundRunSupervisor } from "./background-run-supervisor.js";
import {
  DurableSubrunOrchestrator,
  redundancyPatternProvenUseful,
} from "./durable-subrun-orchestrator.js";
import { buildBackgroundRunQualityArtifact } from "../eval/background-run-quality.js";
import type { DelegationBenchmarkSummary } from "../eval/delegation-benchmark.js";

function makeResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "subrun finished",
    provider: "grok",
    model: "grok-test",
    usedFallback: false,
    toolCalls: [
      {
        name: "system.processStatus",
        args: { processId: "proc-demo" },
        result: '{"processId":"proc-demo","state":"exited"}',
        isError: false,
        durationMs: 10,
      },
    ],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    callUsage: [],
    durationMs: 20,
    compacted: false,
    stopReason: "completed",
    ...overrides,
  };
}

function createRunStore(memoryBackend = new InMemoryBackend()) {
  return new BackgroundRunStore({ memoryBackend });
}

function createSupervisor(runStore: BackgroundRunStore) {
  const publishUpdate = vi.fn(async () => undefined);
  const execute = vi.fn(async () => makeResult());
  const supervisorLlm: LLMProvider = {
    name: "supervisor",
    chat: vi.fn(async () => ({
      content:
        '{"state":"completed","userUpdate":"Subrun complete.","internalSummary":"verified completion","shouldNotifyUser":true}',
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "supervisor-model",
      finishReason: "stop",
    })),
    chatStream: vi.fn(),
    healthCheck: vi.fn(async () => true),
  };
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: { execute } as any,
    supervisorLlm,
    getSystemPrompt: () => "base system prompt",
    runStore,
    createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
    publishUpdate,
  });
  return { supervisor, execute, publishUpdate };
}

function createQualityArtifact(overrides: Record<string, unknown> = {}) {
  return buildBackgroundRunQualityArtifact({
    runId: "quality-test",
    generatedAtMs: 1,
    scenarios: [
      {
        scenarioId: "canary-pass",
        category: "canary",
        ok: true,
        finalState: "completed",
        latencyMs: 120,
        timeToFirstAckMs: 50,
        timeToFirstVerifiedUpdateMs: 200,
        stopLatencyMs: 100,
        falseCompletion: false,
        blockedWithoutNotice: false,
        recoverySucceeded: true,
        verifierAccurate: true,
        replayConsistent: true,
        transcriptScore: 0.99,
        toolTrajectoryScore: 0.98,
        endStateCorrectnessScore: 0.99,
        verifierCorrectnessScore: 0.99,
        restartRecoveryCorrectnessScore: 0.99,
        operatorUxCorrectnessScore: 0.99,
        tokenCount: 50,
        eventCount: 4,
        ...overrides,
      },
    ],
  });
}

function createDelegationSummary(
  overrides: Partial<DelegationBenchmarkSummary> = {},
): DelegationBenchmarkSummary {
  return {
    totalCases: 10,
    delegatedCases: 8,
    usefulDelegations: 6,
    harmfulDelegations: 1,
    plannerExecutionMismatches: 0,
    childTimeouts: 0,
    childFailures: 0,
    synthesisConflicts: 0,
    depthCapHits: 0,
    fanoutCapHits: 0,
    delegationAttemptRate: 0.8,
    usefulDelegationRate: 0.75,
    harmfulDelegationRate: 0.1,
    plannerToExecutionMismatchRate: 0,
    childTimeoutRate: 0,
    childFailureRate: 0,
    synthesisConflictRate: 0,
    depthCapHitRate: 0,
    fanoutCapHitRate: 0,
    costDeltaVsBaseline: 0.02,
    latencyDeltaVsBaseline: -0.1,
    qualityDeltaVsBaseline: 0.12,
    passAtKDeltaVsBaseline: 0.15,
    passCaretKDeltaVsBaseline: 0.09,
    baselineScenarioId: "baseline",
    k: 2,
    scenarioSummaries: [],
    ...overrides,
  };
}

function makeParentRun(
  sessionId: string,
  overrides: Partial<PersistedBackgroundRun> = {},
): PersistedBackgroundRun {
  return {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: `bg-${sessionId}`,
    sessionId,
    objective: "Coordinate durable subruns for this objective.",
    policyScope: {
      tenantId: "tenant-a",
      projectId: "project-a",
      runId: `bg-${sessionId}`,
      sessionId,
      channel: "webchat",
    },
    contract: {
      domain: "generic",
      kind: "finite",
      successCriteria: ["Spawn child work and join it deterministically."],
      completionCriteria: ["All required child outputs are reconciled."],
      blockedCriteria: ["Missing child evidence blocks completion."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: "none" },
    },
    state: "working",
    createdAt: 1,
    updatedAt: 1,
    cycleCount: 1,
    stableWorkingCycles: 0,
    consecutiveErrorCycles: 0,
    nextCheckAt: 10,
    nextHeartbeatAt: 12,
    lastVerifiedAt: 1,
    lastUserUpdate: "Parent run active.",
    lastToolEvidence: "verified",
    lastHeartbeatContent: undefined,
    lastWakeReason: "tool_result",
    carryForward: {
      summary: "Parent supervising child work.",
      verifiedFacts: ["Parent plan accepted."],
      openLoops: [],
      nextFocus: "Join child outputs.",
      artifacts: [],
      memoryAnchors: [],
      providerContinuation: undefined,
      summaryHealth: { status: "healthy", driftCount: 0 },
      lastCompactedAt: 1,
    },
    blocker: undefined,
    approvalState: { status: "none" },
    budgetState: {
      runtimeStartedAt: 1,
      lastActivityAt: 1,
      lastProgressAt: 1,
      totalTokens: 0,
      lastCycleTokens: 0,
      managedProcessCount: 0,
      maxRuntimeMs: 60_000,
      maxCycles: 32,
      maxIdleMs: 30_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: 1,
      firstVerifiedUpdateAt: 1,
      stopRequestedAt: undefined,
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
    fenceToken: 1,
    preferredWorkerId: "worker-local-1",
    workerAffinityKey: sessionId,
    leaseOwnerId: undefined,
    leaseExpiresAt: undefined,
    ...overrides,
  };
}

async function eventuallyAsync(
  assertion: () => Promise<void>,
  attempts = 12,
): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  throw lastError;
}

describe("durable-subrun-orchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it("gates durable subruns on healthy single-agent metrics and helpful redundancy evidence", () => {
    expect(
      redundancyPatternProvenUseful(
        "majority_vote",
        createDelegationSummary({ usefulDelegationRate: 0.2, harmfulDelegationRate: 0.6 }),
      ),
    ).toBe(false);
    expect(
      redundancyPatternProvenUseful(
        "critic",
        createDelegationSummary({ qualityDeltaVsBaseline: 0.2 }),
      ),
    ).toBe(true);
  });

  it("spawns silent child runs with durable lineage and parent events", async () => {
    const runStore = createRunStore();
    const { supervisor } = createSupervisor(runStore);
    const parentSessionId = "session-parent";
    const parentRun = makeParentRun(parentSessionId);
    await runStore.saveRun(parentRun);

    const orchestrator = new DurableSubrunOrchestrator({
      supervisor,
      qualityArtifactProvider: async () => createQualityArtifact(),
      delegationBenchmarkProvider: async () => createDelegationSummary(),
    });

    const started = await orchestrator.startPlan(parentSessionId, {
      rootRunId: parentRun.id,
      joinStrategy: "all_success",
      redundancyPattern: "none",
      children: [
        {
          objective: "Worker one collects process evidence.",
          role: "worker",
          scope: { allowedTools: ["system.processStatus"] },
          artifactContract: { requiredKinds: [] },
          budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
        },
        {
          objective: "Verifier confirms the evidence.",
          role: "verifier",
          scope: { allowedTools: ["system.processStatus"] },
          artifactContract: { requiredKinds: [] },
          budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
        },
      ],
    });

    expect(started.childSessionIds).toEqual([
      "subrun:session-parent:worker:0",
      "subrun:session-parent:verifier:1",
    ]);

    const childRecord = await supervisor.loadRunRecord("subrun:session-parent:worker:0");
    expect(childRecord?.lineage).toMatchObject({
      rootRunId: parentRun.id,
      parentRunId: parentRun.id,
      role: "worker",
      depth: 1,
      scope: { allowedTools: ["system.processStatus"] },
    });

    const events = await runStore.listEvents(parentRun.id, 8);
    expect(
      events.some(
        (event) => event.metadata?.eventType === "subrun_spawned",
      ),
    ).toBe(true);
  });

  it("rejects subrun plans when single-agent quality gates or nested budgets fail", async () => {
    const runStore = createRunStore();
    const { supervisor } = createSupervisor(runStore);
    const parentSessionId = "session-budget-parent";
    const parentRun = makeParentRun(parentSessionId, {
      lineage: {
        rootRunId: `bg-${parentSessionId}`,
        role: "planner",
        depth: 0,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        scope: { allowedTools: ["system.processStatus"] },
        artifactContract: { requiredKinds: [] },
        budget: { maxRuntimeMs: 5_000, maxToolCalls: 4, maxChildren: 1 },
        childRunIds: [],
      },
    });
    await runStore.saveRun(parentRun);

    const orchestrator = new DurableSubrunOrchestrator({
      supervisor,
      qualityArtifactProvider: async () =>
        createQualityArtifact({ falseCompletion: true, ok: false }),
      delegationBenchmarkProvider: async () => createDelegationSummary(),
    });

    await expect(
      orchestrator.startPlan(parentSessionId, {
        rootRunId: parentRun.id,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        children: [
          {
            objective: "Worker over budget.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 10_000, maxToolCalls: 6, maxChildren: 1 },
          },
        ],
      }),
    ).rejects.toThrow(/quality gates failed/i);

    const healthyOrchestrator = new DurableSubrunOrchestrator({
      supervisor,
      qualityArtifactProvider: async () => createQualityArtifact(),
      delegationBenchmarkProvider: async () => createDelegationSummary(),
    });

    await expect(
      healthyOrchestrator.startPlan(parentSessionId, {
        rootRunId: parentRun.id,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        children: [
          {
            objective: "Worker one.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 4_000, maxToolCalls: 2, maxChildren: 1 },
          },
          {
            objective: "Worker two.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 4_000, maxToolCalls: 2, maxChildren: 1 },
          },
        ],
      }),
    ).rejects.toThrow(/exceeds parent/i);
  });

  it("applies runtime admission policy before spawning multi-agent subruns", async () => {
    const runStore = createRunStore();
    const { supervisor } = createSupervisor(runStore);
    const parentSessionId = "session-canary-parent";
    const parentRun = makeParentRun(parentSessionId);
    await runStore.saveRun(parentRun);

    const orchestrator = new DurableSubrunOrchestrator({
      supervisor,
      qualityArtifactProvider: async () => createQualityArtifact(),
      delegationBenchmarkProvider: async () => createDelegationSummary(),
      admissionEvaluator: async () => ({
        allowed: false,
        reason: "Multi-agent canary rollout is not enabled for this tenant.",
      }),
    });

    await expect(
      orchestrator.startPlan(parentSessionId, {
        rootRunId: parentRun.id,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        children: [
          {
            objective: "Worker one.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 4_000, maxToolCalls: 2, maxChildren: 1 },
          },
        ],
      }),
    ).rejects.toThrow(/canary rollout is not enabled/i);
  });

  it("joins child runs deterministically and reconstructs parent/child trees after restart", async () => {
    const sqliteDir = await mkdtemp(join(tmpdir(), "agenc-subruns-"));
    try {
      const backend = new SqliteBackend({ dbPath: join(sqliteDir, "runs.sqlite") });
      const runStore = createRunStore(backend);
      const { supervisor } = createSupervisor(runStore);
      const parentSessionId = "session-tree-parent";
      const parentRun = makeParentRun(parentSessionId);
      await runStore.saveRun(parentRun);

      const orchestrator = new DurableSubrunOrchestrator({
        supervisor,
        qualityArtifactProvider: async () => createQualityArtifact(),
        delegationBenchmarkProvider: async () => createDelegationSummary(),
      });

      await orchestrator.startPlan(parentSessionId, {
        rootRunId: parentRun.id,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        children: [
          {
            objective: "Worker one collects evidence.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
          },
          {
            objective: "Verifier validates evidence.",
            role: "verifier",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(0);
      await eventuallyAsync(async () => {
        const child = await supervisor.loadRunRecord("subrun:session-tree-parent:worker:0");
        expect(child?.state).toBe("completed");
      });

      const outcome = await orchestrator.evaluatePlanJoin(parentSessionId, {
        rootRunId: parentRun.id,
        joinStrategy: "all_success",
        redundancyPattern: "none",
        children: [
          {
            objective: "Worker one collects evidence.",
            role: "worker",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
          },
          {
            objective: "Verifier validates evidence.",
            role: "verifier",
            scope: { allowedTools: ["system.processStatus"] },
            artifactContract: { requiredKinds: [] },
            budget: { maxRuntimeMs: 10_000, maxToolCalls: 2, maxChildren: 1 },
          },
        ],
      });
      expect(outcome.status).toBe("completed");

      const reloadedStore = createRunStore(
        new SqliteBackend({ dbPath: join(sqliteDir, "runs.sqlite") }),
      );
      const { supervisor: reloadedSupervisor } = createSupervisor(reloadedStore);
      const reloadedOrchestrator = new DurableSubrunOrchestrator({
        supervisor: reloadedSupervisor,
        qualityArtifactProvider: async () => createQualityArtifact(),
        delegationBenchmarkProvider: async () => createDelegationSummary(),
      });

      const tree = await reloadedOrchestrator.buildRunTree(parentRun.id);
      expect(tree?.runId).toBe(parentRun.id);
      expect(tree?.children).toHaveLength(2);
      expect(tree?.children.map((child) => child.role)).toEqual(["worker", "verifier"]);
    } finally {
      await rm(sqliteDir, { recursive: true, force: true });
    }
  });
});
