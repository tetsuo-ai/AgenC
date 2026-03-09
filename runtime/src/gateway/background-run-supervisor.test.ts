import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import { PolicyEngine } from "../policy/engine.js";
import {
  BackgroundRunSupervisor,
  inferBackgroundRunIntent,
  isBackgroundRunPauseRequest,
  isBackgroundRunResumeRequest,
  isBackgroundRunStatusRequest,
  isBackgroundRunStopRequest,
} from "./background-run-supervisor.js";
import { BackgroundRunNotifier } from "./background-run-notifier.js";
import { BackgroundRunStore } from "./background-run-store.js";
import { AGENT_RUN_SCHEMA_VERSION } from "./agent-run-contract.js";

function makeResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "ok",
    provider: "grok",
    model: "grok-test",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    ...overrides,
  };
}

function makeCallUsageRecord(overrides: Record<string, unknown> = {}) {
  return {
    callIndex: 1,
    phase: "initial",
    provider: "grok",
    model: "grok-test",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    beforeBudget: {
      messageCount: 1,
      systemMessages: 1,
      userMessages: 0,
      assistantMessages: 0,
      toolMessages: 0,
      estimatedChars: 20,
      systemPromptChars: 10,
    },
    afterBudget: {
      messageCount: 1,
      systemMessages: 1,
      userMessages: 0,
      assistantMessages: 0,
      toolMessages: 0,
      estimatedChars: 20,
      systemPromptChars: 10,
    },
    ...overrides,
  };
}

function createRunStore() {
  return new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void, attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  throw lastError;
}

async function eventuallyAsync(
  assertion: () => Promise<void>,
  attempts = 10,
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

function makePersistedRunRecord(
  overrides: Record<string, unknown> & {
    readonly sessionId: string;
    readonly objective: string;
  },
) {
  const contractOverrides = (overrides.contract ?? {}) as Record<string, unknown>;
  const record = {
    version: AGENT_RUN_SCHEMA_VERSION,
    id: "bg-persisted",
    sessionId: overrides.sessionId,
    objective: overrides.objective,
    policyScope: {
      tenantId: "tenant-a",
      projectId: "project-x",
      runId: "run-bg-persisted",
    },
    contract: {
      domain: "generic",
      kind: "finite",
      successCriteria: ["Verify the objective completes."],
      completionCriteria: ["Observe deterministic completion evidence."],
      blockedCriteria: ["Required runtime evidence is missing."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: "none" },
      ...contractOverrides,
    },
    state: "working",
    fenceToken: 1,
    createdAt: 1,
    updatedAt: 1,
    cycleCount: 1,
    stableWorkingCycles: 0,
    consecutiveErrorCycles: 0,
    nextCheckAt: 10,
    nextHeartbeatAt: undefined,
    lastVerifiedAt: 1,
    lastUserUpdate: undefined,
    lastToolEvidence: undefined,
    lastHeartbeatContent: undefined,
    lastWakeReason: "tool_result",
    carryForward: undefined,
    blocker: undefined,
    approvalState: { status: "none" },
    budgetState: {
      runtimeStartedAt: 1,
      lastActivityAt: 1,
      lastProgressAt: 1,
      totalTokens: 0,
      lastCycleTokens: 0,
      managedProcessCount: 0,
      maxRuntimeMs: 604_800_000,
      maxCycles: 512,
      maxIdleMs: undefined,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: undefined,
      firstVerifiedUpdateAt: undefined,
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
    leaseOwnerId: undefined,
    leaseExpiresAt: undefined,
    ...overrides,
  };
  return {
    ...record,
    contract: {
      domain: "generic",
      kind: "finite",
      successCriteria: ["Verify the objective completes."],
      completionCriteria: ["Observe deterministic completion evidence."],
      blockedCriteria: ["Required runtime evidence is missing."],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: "none" },
      ...contractOverrides,
    },
  };
}

function createManagedProcessToolHandler(params?: {
  readonly initialProcessId?: string;
  readonly label?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly surface?: "desktop" | "host";
}) {
  const state = {
    processId: params?.initialProcessId ?? "proc_watcher",
    label: params?.label ?? "watcher",
    command: params?.command ?? "/bin/sleep",
    args: [...(params?.args ?? ["2"])],
    cwd: params?.cwd ?? "/tmp",
    surface: params?.surface ?? "desktop",
    currentState: "running" as "running" | "exited",
    exitCode: 0 as number | null,
    restartCount: 0,
  };

  const statusToolName =
    state.surface === "host" ? "system.processStatus" : "desktop.process_status";
  const startToolName =
    state.surface === "host" ? "system.processStart" : "desktop.process_start";

  const handler = vi.fn<ToolHandler>(async (name, args) => {
    if (name === statusToolName) {
      return JSON.stringify({
        processId: state.processId,
        label: state.label,
        command: state.command,
        args: state.args,
        cwd: state.cwd,
        state: state.currentState,
        exitCode: state.currentState === "exited" ? state.exitCode : undefined,
      });
    }
    if (name === startToolName) {
      state.restartCount += 1;
      state.processId =
        state.restartCount === 1
          ? "proc_watcher_2"
          : `proc_watcher_${state.restartCount + 1}`;
      state.currentState = "running";
      state.exitCode = 0;
      state.command =
        typeof args.command === "string" ? args.command : state.command;
      state.args = Array.isArray(args.args)
        ? args.args.map((value) => String(value))
        : state.args;
      state.cwd = typeof args.cwd === "string" ? args.cwd : state.cwd;
      state.label = typeof args.label === "string" ? args.label : state.label;
      return JSON.stringify({
        processId: state.processId,
        label: state.label,
        command: state.command,
        args: state.args,
        cwd: state.cwd,
        state: "running",
        started: true,
      });
    }
    throw new Error(`unexpected tool ${name}`);
  });

  return {
    handler,
    markExited(exitCode = 0) {
      state.currentState = "exited";
      state.exitCode = exitCode;
    },
    snapshot() {
      return { ...state, args: [...state.args] };
    },
    toolNames: {
      status: statusToolName,
      start: startToolName,
    },
  };
}

describe("background-run-supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it("detects explicit long-running intent", () => {
    expect(
      inferBackgroundRunIntent(
        "Start Doom and keep playing until I tell you to stop.",
      ),
    ).toBe(true);
    expect(
      inferBackgroundRunIntent(
        "Monitor this in the background and keep me updated.",
      ),
    ).toBe(true);
    expect(inferBackgroundRunIntent("What is 2+2?")).toBe(false);
    expect(isBackgroundRunStopRequest("stop")).toBe(true);
    expect(isBackgroundRunStopRequest("pause")).toBe(false);
    expect(isBackgroundRunPauseRequest("pause")).toBe(true);
    expect(isBackgroundRunResumeRequest("resume")).toBe(true);
    expect(isBackgroundRunStatusRequest("status")).toBe(true);
  });

  it("starts a run, executes a cycle, and keeps it working", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(async () =>
      makeResult({
        content: "Doom launched and verified.",
        toolCalls: [
          {
            name: "mcp.doom.start_game",
            args: { async_player: true },
            result: '{"status":"running"}',
            isError: false,
            durationMs: 25,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi.fn(async () => ({
        content:
          '{"state":"working","userUpdate":"Doom is still running in the background.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
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
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-1",
      objective: "Play Doom until I say stop and keep me updated.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });

    expect(execute.mock.calls[0]?.[0].message.content).toContain("Cycle: 1");
    expect(execute.mock.calls[0]?.[0].systemPrompt).toContain(
      "launch it so the tool call returns immediately",
    );
    expect(execute.mock.calls[0]?.[0].maxToolRounds).toBe(1);
    expect(execute.mock.calls[0]?.[0].toolBudgetPerRequest).toBe(4);
    expect(execute.mock.calls[0]?.[0].maxModelRecallsPerRequest).toBe(0);
    expect(publishUpdate).toHaveBeenNthCalledWith(
      1,
      "session-1",
      expect.stringContaining("Started a background run"),
    );
    expect(publishUpdate).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "Doom is still running in the background.",
    );

    const snapshot = supervisor.getStatusSnapshot("session-1");
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.cycleCount).toBe(1);
    expect(snapshot?.nextCheckAt).toBeTypeOf("number");
    const remainingMs = (snapshot?.nextCheckAt ?? 0) - Date.now();
    expect(remainingMs).toBeGreaterThanOrEqual(3_500);
    expect(remainingMs).toBeLessThanOrEqual(4_000);
  });

  it("passes provider trace options to actor and supervisor calls when enabled", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(async () =>
      makeResult({
        content: "Cycle complete",
      })
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi.fn(async () => ({
        content:
          '{"state":"completed","userUpdate":"Done.","internalSummary":"verified completion","shouldNotifyUser":true}',
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
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
      traceProviderPayloads: true,
    });

    await supervisor.startRun({
      sessionId: "trace-session",
      objective: "Check status until you are done.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        trace: expect.objectContaining({
          includeProviderPayloads: true,
          onProviderTraceEvent: expect.any(Function),
          onExecutionTraceEvent: expect.any(Function),
        }),
      }),
    );
    expect(supervisorLlm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        toolChoice: "none",
        trace: expect.objectContaining({
          includeProviderPayloads: true,
          onProviderTraceEvent: expect.any(Function),
        }),
      }),
    );
  });

  it("fans durable lifecycle events out to configured notification sinks", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new BackgroundRunNotifier({
      config: {
        enabled: true,
        sinks: [
          {
            id: "ops-webhook",
            type: "webhook",
            url: "https://example.com/hook",
            events: ["run_started", "run_completed"],
          },
        ],
      },
      fetchImpl,
    });
    const execute = vi.fn(async () =>
      makeResult({
        content: "Verified completion.",
        toolCalls: [
          {
            name: "system.processStatus",
            args: { processId: "proc-demo" },
            result: '{"processId":"proc-demo","state":"exited"}',
            isError: false,
            durationMs: 8,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi.fn(async () => ({
        content:
          '{"state":"completed","userUpdate":"Objective satisfied.","internalSummary":"verified complete","shouldNotifyUser":true}',
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
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
      notifier,
    });

    await supervisor.startRun({
      sessionId: "session-1",
      objective: "Watch until it completes.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    const firstBody = JSON.parse(
      String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body),
    );
    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body),
    );
    expect(firstBody.eventType).toBe("run_started");
    expect(secondBody.eventType).toBe("run_completed");
  });

  it("grounds optimistic working decisions when every tool call in the cycle failed", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(async () =>
      makeResult({
        content: "Game not started yet. Launching Doom now.",
        toolCalls: [
          {
            name: "mcp.doom.get_situation_report",
            args: {},
            result: "No game is running. Call start_game first.",
            isError: true,
            durationMs: 15,
          },
        ],
      }),
    );

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"working","userUpdate":"Doom is running in the background.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-grounded",
      objective: "Play Doom until I say stop and keep me updated.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(publishUpdate).toHaveBeenNthCalledWith(
      2,
      "session-grounded",
      expect.stringContaining("Latest cycle hit only tool errors and will retry"),
    );
    expect(publishUpdate.mock.calls[1]?.[1]).toContain("No game is running");
    expect(publishUpdate.mock.calls[1]?.[1]).not.toContain("Doom is running in the background.");

    const snapshot = supervisor.getStatusSnapshot("session-grounded");
    expect(snapshot?.state).toBe("working");
  });

  it("treats bounded-step stop reasons with successful tool evidence as working", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "",
            stopReason: "budget_exceeded",
            stopReasonDetail:
              "Max model recalls exceeded while following up after tool calls",
            toolCalls: [
              {
                name: "desktop.bash",
                args: { command: "touch /tmp/example &" },
                result: '{"stdout":"","stderr":"","exitCode":0,"backgrounded":true}',
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => {
          throw new Error("supervisor unavailable");
        }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-bounded",
      objective: "Keep this task running in the background until it completes.",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(publishUpdate).toHaveBeenNthCalledWith(
      2,
      "session-bounded",
      "Completed a bounded background step and will verify again shortly.",
    );
    const snapshot = supervisor.getStatusSnapshot("session-bounded");
    expect(snapshot?.state).toBe("working");
  });

  it("completes and removes a run when the supervisor decides it is done", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "Task finished.",
            toolCalls: [
              {
                name: "system.bash",
                args: { command: "echo", args: ["done"] },
                result: "done",
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"completed","userUpdate":"Background task completed successfully.","internalSummary":"finished","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-2",
      objective: "Do the task in the background.",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(supervisor.hasActiveRun("session-2")).toBe(false);
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-2",
      "Background task completed successfully.",
    );
  });

  it("keeps a recent terminal snapshot after completion for runtime-owned control replies", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "Task finished.",
            toolCalls: [
              {
                name: "desktop.process_status",
                args: { processId: "proc_1" },
                result: '{"state":"exited"}',
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"completed","userUpdate":"Process finished successfully.","internalSummary":"finished","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-terminal-snapshot",
      objective: "Watch the process until it exits.",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(supervisor.getStatusSnapshot("session-terminal-snapshot")).toBeUndefined();
    await expect(
      supervisor.getRecentSnapshot("session-terminal-snapshot"),
    ).resolves.toMatchObject({
      sessionId: "session-terminal-snapshot",
      state: "completed",
      lastUserUpdate: "Process finished successfully.",
    });
  });

  it("cancels an active run", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () => makeResult()),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"working","userUpdate":"still running","internalSummary":"working","nextCheckMs":4000,"shouldNotifyUser":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-3",
      objective: "Keep monitoring this until I say stop.",
    });

    const cancelled = await supervisor.cancelRun("session-3", "Stopped by user.");
    expect(cancelled).toBe(true);
    expect(supervisor.hasActiveRun("session-3")).toBe(false);
    expect(publishUpdate).toHaveBeenLastCalledWith("session-3", "Stopped by user.");
  });

  it("exposes operator detail and persists objective, constraint, and budget interventions", async () => {
    const runStore = createRunStore();
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(async () =>
      makeResult({
        content: "Watcher started.",
        toolCalls: [
          {
            name: "system.processStart",
            args: { command: "/bin/sleep", args: ["5"] },
            result: '{"processId":"proc_1","state":"running"}',
            isError: false,
            durationMs: 10,
          },
        ],
      }),
    );
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"working","userUpdate":"Managed process is still running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-ops",
      objective: "Watch the process until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });

    await supervisor.updateRunObjective(
      "session-ops",
      "Watch the process and report the exit code.",
      "Operator refined the goal.",
    );
    await supervisor.amendRunConstraints(
      "session-ops",
      {
        successCriteria: ["Observe the process exit code."],
        blockedCriteria: ["Missing exit evidence."],
        nextCheckMs: 7_000,
      },
      "Operator tightened the verifier contract.",
    );
    await supervisor.adjustRunBudget(
      "session-ops",
      {
        maxRuntimeMs: 120_000,
        maxCycles: 12,
      },
      "Operator narrowed the budget.",
    );

    const detail = await supervisor.getOperatorDetail("session-ops");
    expect(detail).toMatchObject({
      sessionId: "session-ops",
      objective: "Watch the process and report the exit code.",
    });
    expect(detail?.contract.successCriteria).toEqual([
      "Observe the process exit code.",
    ]);
    expect(detail?.contract.blockedCriteria).toEqual([
      "Missing exit evidence.",
    ]);
    expect(detail?.contract.nextCheckMs).toBe(7_000);
    expect(detail?.budget.maxRuntimeMs).toBe(120_000);
    expect(detail?.budget.maxCycles).toBe(12);

    const summaries = await supervisor.listOperatorSummaries(["session-ops"]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.objective).toBe(
      "Watch the process and report the exit code.",
    );

    const events = await runStore.listEvents(detail!.runId);
    expect(events.map((entry) => entry.metadata?.eventType)).toEqual(
      expect.arrayContaining([
        "run_objective_updated",
        "run_contract_amended",
        "run_budget_adjusted",
      ]),
    );
  });

  it("retries a terminal checkpoint and records verification overrides", async () => {
    const runStore = createRunStore();
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(async () =>
      makeResult({
        content: "Watcher completed.",
        toolCalls: [
          {
            name: "system.processStatus",
            args: { processId: "proc_1" },
            result: '{"processId":"proc_1","state":"exited","exitCode":0}',
            isError: false,
            durationMs: 10,
          },
        ],
      }),
    );
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"completed","userUpdate":"Managed process exited cleanly.","internalSummary":"verified exit","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-retry",
      objective: "Watch the process until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventuallyAsync(async () => {
      expect(await runStore.loadCheckpoint("session-retry")).toBeDefined();
    });

    await supervisor.retryRunFromCheckpoint(
      "session-retry",
      "Operator requested a retry from the terminal checkpoint.",
    );

    let detail = await supervisor.getOperatorDetail("session-retry");
    expect(detail?.state).toBe("working");
    expect(detail?.checkpointAvailable).toBe(true);

    await supervisor.applyVerificationOverride("session-retry", {
      mode: "fail",
      reason: "Operator marked the replay invalid.",
      userUpdate: "Operator override recorded: replay invalid.",
    });

    detail = await supervisor.getOperatorDetail("session-retry");
    expect(detail?.state).toBe("failed");
    expect(detail?.unsafeToContinue).toBe(true);

    const events = await runStore.listEvents(detail!.runId);
    expect(events.map((entry) => entry.metadata?.eventType)).toEqual(
      expect.arrayContaining(["run_retried", "run_verification_overridden"]),
    );
  });

  it("pauses a run, queues signals without waking it, and resumes cleanly", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher started.",
          toolCalls: [
            {
              name: "desktop.process_start",
              args: { command: "/bin/sleep", args: ["30"] },
              result: '{"state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher resumed with the queued instruction applied.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "proc_1" },
              result: '{"state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      );
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '{"kind":"until_stopped","successCriteria":["keep watcher running"],"completionCriteria":["user explicitly stops it"],"blockedCriteria":["missing process controls"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"running","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"summary":"Watcher is running.","verifiedFacts":["Watcher is running."],"openLoops":["Apply queued resume instruction."],"nextFocus":"Resume and continue monitoring."}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"working","userUpdate":"Watcher resumed successfully.","internalSummary":"resumed","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"summary":"Watcher resumed and is still running.","verifiedFacts":["Watcher is running."],"openLoops":["Continue monitoring."],"nextFocus":"Continue supervision."}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-pause-resume",
      objective: "Keep monitoring the watcher until I tell you to stop.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-pause-resume")?.state).toBe("working");

    await supervisor.pauseRun("session-pause-resume");
    expect(supervisor.getStatusSnapshot("session-pause-resume")?.state).toBe("paused");

    await supervisor.signalRun({
      sessionId: "session-pause-resume",
      content: "If it fails, restart it instead of stopping.",
      type: "user_input",
    });
    expect(supervisor.getStatusSnapshot("session-pause-resume")?.pendingSignals).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);

    await supervisor.resumeRun("session-pause-resume");
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatusSnapshot("session-pause-resume")?.state).toBe("working");
    expect(publishUpdate).toHaveBeenCalledWith(
      "session-pause-resume",
      "Paused the active background run for this session.",
    );
    expect(publishUpdate).toHaveBeenCalledWith(
      "session-pause-resume",
      "Resumed the background run for this session.",
    );
  });

  it("preserves the latest deterministic update while a stable background run waits for the next verification", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "File does not exist yet.",
          toolCalls: [
            {
              name: "desktop.bash",
              args: { command: "test -f /tmp/file" },
              result: "File does not exist yet",
              isError: false,
              durationMs: 20,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Background job started.",
          toolCalls: [
            {
              name: "desktop.bash",
              args: { command: "test -f /tmp/file" },
              result: "File does not exist yet",
              isError: false,
              durationMs: 8,
            },
          ],
        }),
      )
      .mockResolvedValue(
        makeResult({
          content: "Background job started.",
          toolCalls: [
            {
              name: "desktop.bash",
              args: { command: "test -f /tmp/file" },
              result: "File does not exist yet",
              isError: false,
              durationMs: 8,
            },
          ],
        }),
      );

    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["verify the file state"],"completionCriteria":["file appears"],"blockedCriteria":["missing filesystem access"],"nextCheckMs":30000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"File does not exist yet.","internalSummary":"waiting for file","nextCheckMs":30000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"File does not exist yet.","internalSummary":"waiting for file","nextCheckMs":30000,"shouldNotifyUser":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValue({
          content:
            '{"state":"working","userUpdate":"File does not exist yet.","internalSummary":"waiting for file","nextCheckMs":30000,"shouldNotifyUser":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-heartbeat",
      objective: "Start a background job and keep monitoring it.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-heartbeat",
      "Tool result observed for desktop.bash.",
    );

    const snapshot = supervisor.getStatusSnapshot("session-heartbeat");
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.nextHeartbeatAt).toBeUndefined();
    expect(snapshot?.nextCheckAt).toBeTypeOf("number");
  });

  it("publishes a runtime heartbeat while a background cycle is still running", async () => {
    let resolveExecute: ((result: ChatExecutorResult) => void) | undefined;
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn(
      () =>
        new Promise<ChatExecutorResult>((resolve) => {
          resolveExecute = resolve;
        }),
    );

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"blocked","userUpdate":"waiting","internalSummary":"waiting","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-running-heartbeat",
      objective: "Keep monitoring this in the background.",
    });
    await vi.advanceTimersByTimeAsync(8_000);

    expect(publishUpdate).toHaveBeenNthCalledWith(
      2,
      "session-running-heartbeat",
      expect.stringContaining("Still working on the current background cycle."),
    );
    expect(supervisor.getStatusSnapshot("session-running-heartbeat")?.state).toBe("running");

    resolveExecute?.(
      makeResult({
        content: "still checking",
        stopReason: "completed",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps until-stopped runs working even when the supervisor suggests completion", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "Doom is launched and verified.",
            toolCalls: [
              {
                name: "mcp.doom.start_game",
                args: { async_player: true },
                result: '{"status":"running"}',
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '{"kind":"until_stopped","successCriteria":["keep task running"],"completionCriteria":["user explicitly stops it"],"blockedCriteria":["missing tooling"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"completed","userUpdate":"Doom setup complete.","internalSummary":"done","shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-until-stop",
      objective: "Keep playing Doom until I tell you to stop.",
    });
    await vi.runOnlyPendingTimersAsync();

    expect(supervisor.getStatusSnapshot("session-until-stop")?.state).toBe("working");
  });

  it("does not expire an until-stopped run just because it exceeds the runtime cap", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "Process is still running.",
            toolCalls: [
              {
                name: "desktop.process_status",
                args: { processId: "proc_1" },
                result: '{"state":"running"}',
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '{"kind":"until_stopped","successCriteria":["keep task running"],"completionCriteria":["user explicitly stops it"],"blockedCriteria":["missing tooling"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"working","userUpdate":"Still running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
      now: () => Date.now(),
    });

    await supervisor.startRun({
      sessionId: "session-until-stop-runtime-cap",
      objective: "Keep monitoring until I tell you to stop.",
    });
    await vi.runOnlyPendingTimersAsync();

    const activeRun = (supervisor as any).activeRuns.get(
      "session-until-stop-runtime-cap",
    );
    activeRun.createdAt = Date.now() - (8 * 24 * 60 * 60_000);

    await (supervisor as any).executeCycle("session-until-stop-runtime-cap");

    expect(
      supervisor.getStatusSnapshot("session-until-stop-runtime-cap")?.state,
    ).toBe("working");
  });

  it("does not expire an until-stopped run just because it exceeds the cycle cap", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi.fn(async () =>
          makeResult({
            content: "Process is still running.",
            toolCalls: [
              {
                name: "desktop.process_status",
                args: { processId: "proc_2" },
                result: '{"state":"running"}',
                isError: false,
                durationMs: 5,
              },
            ],
          }),
        ),
      } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '{"kind":"until_stopped","successCriteria":["keep task running"],"completionCriteria":["user explicitly stops it"],"blockedCriteria":["missing tooling"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"working","userUpdate":"Still running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-until-stop-cycle-cap",
      objective: "Keep monitoring until I tell you to stop.",
    });
    await vi.runOnlyPendingTimersAsync();

    const activeRun = (supervisor as any).activeRuns.get(
      "session-until-stop-cycle-cap",
    );
    activeRun.cycleCount = 512;

    await (supervisor as any).executeCycle("session-until-stop-cycle-cap");

    expect(
      supervisor.getStatusSnapshot("session-until-stop-cycle-cap")?.state,
    ).toBe("working");
  });

  it("recovers persisted runs after restart with sqlite durability", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenc-bg-run-"));
    const dbPath = join(tempDir, "memory.sqlite");

    try {
      const backend1 = new SqliteBackend({ dbPath });
      const runStore1 = new BackgroundRunStore({ memoryBackend: backend1 });
      const publishUpdate1 = vi.fn(async () => undefined);
      const execute1 = vi
        .fn()
        .mockResolvedValueOnce(
          makeResult({
            content: "Watcher started.",
            toolCalls: [
              {
                name: "desktop.process_start",
                args: { label: "watcher" },
                result: '{"processId":"proc_recover","label":"watcher","state":"running"}',
                isError: false,
                durationMs: 4,
              },
            ],
            callUsage: [
              makeCallUsageRecord({
                provider: "grok",
                statefulDiagnostics: {
                  enabled: true,
                  attempted: false,
                  continued: false,
                  store: true,
                  fallbackToStateless: true,
                  responseId: "resp_recover_1",
                  reconciliationHash: "hash_recover_1",
                },
                compactionDiagnostics: {
                  enabled: true,
                  requested: true,
                  active: true,
                  mode: "server_side_context_management",
                  threshold: 12_000,
                  observedItemCount: 1,
                  latestItem: {
                    type: "compaction",
                    id: "cmp_recover_1",
                    digest: "recoverdigest0001",
                  },
                },
              }),
            ],
          }),
        );
      const supervisorLlm1: LLMProvider = {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              '{"kind":"until_condition","successCriteria":["verify the watcher"],"completionCriteria":["condition becomes true"],"blockedCriteria":["missing process tooling"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })
          .mockResolvedValueOnce({
            content:
              '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      };
      const supervisor1 = new BackgroundRunSupervisor({
        chatExecutor: { execute: execute1 } as any,
        supervisorLlm: supervisorLlm1,
        getSystemPrompt: () => "base system prompt",
        runStore: runStore1,
        createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
        publishUpdate: publishUpdate1,
      });

      await supervisor1.startRun({
        sessionId: "session-recover",
        objective: "Monitor the watcher in the background and keep me updated.",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(supervisor1.getStatusSnapshot("session-recover")?.state).toBe("working");
      await expect(runStore1.loadRun("session-recover")).resolves.toMatchObject({
        state: "working",
        fenceToken: 2,
        carryForward: expect.objectContaining({
          providerContinuation: expect.objectContaining({
            responseId: "resp_recover_1",
            reconciliationHash: "hash_recover_1",
          }),
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: "opaque_provider_state",
              locator: "provider:grok:compaction:cmp_recover_1",
              digest: "recoverdigest0001",
            }),
          ]),
        }),
        budgetState: expect.objectContaining({
          maxRuntimeMs: 604_800_000,
          maxCycles: 512,
          nextCheckIntervalMs: 4000,
        }),
        compaction: expect.objectContaining({
          refreshCount: 1,
        }),
        watchRegistrations: [
          expect.objectContaining({
            targetId: "proc_recover",
            label: "watcher",
          }),
        ],
        blocker: undefined,
        approvalState: { status: "none" },
      });
      expect((await runStore1.listRuns()).length).toBe(1);
      await supervisor1.shutdown();
      await expect(runStore1.loadRun("session-recover")).resolves.toMatchObject({
        state: "suspended",
        budgetState: expect.objectContaining({
          maxRuntimeMs: 604_800_000,
          maxCycles: 512,
        }),
        watchRegistrations: [
          expect.objectContaining({
            targetId: "proc_recover",
          }),
        ],
      });
      expect((await runStore1.listRuns()).length).toBe(1);
      await backend1.close();

      const backend2 = new SqliteBackend({ dbPath });
      const runStore2 = new BackgroundRunStore({ memoryBackend: backend2 });
      const publishUpdate2 = vi.fn(async () => undefined);
      const execute2 = vi.fn(async () =>
        makeResult({
          content: "Watcher still running.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "watcher" },
              result: '{"processId":"proc_recover","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 3,
            },
          ],
        }),
      );
      const supervisorLlm2: LLMProvider = {
        name: "supervisor",
        chat: vi
          .fn()
          .mockResolvedValue({
            content:
              '{"state":"working","userUpdate":"Watcher is still running.","internalSummary":"verified after restart","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          }),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      };
      const supervisor2 = new BackgroundRunSupervisor({
        chatExecutor: { execute: execute2 } as any,
        supervisorLlm: supervisorLlm2,
        getSystemPrompt: () => "base system prompt",
        runStore: runStore2,
        createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
        publishUpdate: publishUpdate2,
      });

      expect((await runStore2.listRuns()).length).toBe(1);
      const recovered = await supervisor2.recoverRuns();
      expect(recovered).toBe(1);
      expect(supervisor2.getStatusSnapshot("session-recover")).toMatchObject({
        state: "working",
        watchCount: 1,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(execute2).toHaveBeenCalledTimes(1);
      expect(execute2.mock.calls[0]?.[0]).toMatchObject({
        stateful: {
          resumeAnchor: {
            previousResponseId: "resp_recover_1",
            reconciliationHash: "hash_recover_1",
          },
        },
      });
      await expect(runStore2.loadRun("session-recover")).resolves.toMatchObject({
        state: "working",
        fenceToken: expect.any(Number),
        carryForward: expect.objectContaining({
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: "opaque_provider_state",
              locator: "provider:grok:compaction:cmp_recover_1",
              digest: "recoverdigest0001",
            }),
          ]),
        }),
        budgetState: expect.objectContaining({
          maxRuntimeMs: 604_800_000,
          maxCycles: 512,
        }),
        compaction: expect.objectContaining({
          lastHistoryLength: expect.any(Number),
        }),
        watchRegistrations: [
          expect.objectContaining({
            targetId: "proc_recover",
          }),
        ],
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(execute2).toHaveBeenCalledTimes(2);
      await backend2.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows only one daemon instance to recover and own a persisted run lease", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenc-bg-run-lease-"));
    const dbPath = join(tempDir, "memory.sqlite");

    try {
      const backend = new SqliteBackend({ dbPath });
      const runStore = new BackgroundRunStore({ memoryBackend: backend });
      await runStore.saveRun({
        version: AGENT_RUN_SCHEMA_VERSION,
        id: "bg-lease",
        sessionId: "session-lease",
        objective: "Keep the watcher running.",
        contract: {
          kind: "until_stopped",
          successCriteria: ["Keep the watcher running."],
          completionCriteria: ["User explicitly stops the run."],
          blockedCriteria: ["Missing watcher tooling."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: true,
        },
        state: "working",
        fenceToken: 1,
        createdAt: 1,
        updatedAt: 1,
        cycleCount: 1,
        stableWorkingCycles: 0,
        consecutiveErrorCycles: 0,
        nextCheckAt: 10_000,
        nextHeartbeatAt: undefined,
        lastVerifiedAt: 1,
        lastUserUpdate: "Watcher is still running.",
        lastToolEvidence: "desktop.process_status [ok] running",
        lastHeartbeatContent: undefined,
        lastWakeReason: "timer",
        carryForward: undefined,
        blocker: undefined,
        approvalState: { status: "none" },
        budgetState: {
          runtimeStartedAt: 1,
          lastActivityAt: 1,
          lastProgressAt: 1,
          maxRuntimeMs: 604_800_000,
          maxCycles: 512,
          maxIdleMs: undefined,
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
        leaseOwnerId: undefined,
        leaseExpiresAt: undefined,
      });
      await backend.close();

      const makeSupervisor = () => new BackgroundRunSupervisor({
        chatExecutor: { execute: vi.fn(async () => makeResult()) } as any,
        supervisorLlm: {
          name: "supervisor",
          chat: vi.fn(async () => ({
            content:
              '{"state":"working","userUpdate":"Watcher still running.","internalSummary":"verified","nextCheckMs":4000,"shouldNotifyUser":true}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })),
          chatStream: vi.fn(),
          healthCheck: vi.fn(async () => true),
        },
        getSystemPrompt: () => "base system prompt",
        runStore: new BackgroundRunStore({
          memoryBackend: new SqliteBackend({ dbPath }),
        }),
        createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
        publishUpdate: vi.fn(async () => undefined),
      });

      const supervisorA = makeSupervisor();
      const supervisorB = makeSupervisor();

      await expect(supervisorA.recoverRuns()).resolves.toBe(1);
      await expect(supervisorB.recoverRuns()).resolves.toBe(0);
      expect(supervisorA.getStatusSnapshot("session-lease")?.state).toBe("working");
      expect(supervisorB.getStatusSnapshot("session-lease")).toBeUndefined();

      await supervisorA.shutdown();
      await supervisorB.shutdown();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale claimed dispatch on a standby worker after the owner heartbeat stops", async () => {
    const runStore = createRunStore();
    const publishUpdate = vi.fn(async () => undefined);

    await runStore.saveRun(
      makePersistedRunRecord({
        id: "bg-failover-dispatch",
        sessionId: "session-failover-dispatch",
        objective: "Download the report from the browser session.",
        contract: {
          domain: "browser",
          successCriteria: ["Download the report artifact."],
          completionCriteria: ["Observe the report download completing."],
          blockedCriteria: ["Browser automation fails."],
        },
        pendingSignals: [
          {
            id: "sig-failover-dispatch",
            type: "tool_result",
            content: "Browser download completed at /tmp/report.pdf.",
            timestamp: 1,
            data: {
              category: "browser",
              toolName: "mcp.browser.browser_download",
              eventType: "browser.download.completed",
              path: "/tmp/report.pdf",
            },
          },
        ],
        preferredWorkerId: "worker-a",
        workerAffinityKey: "session:session-failover-dispatch",
      }),
    );
    await runStore.heartbeatWorker({
      workerId: "worker-a",
      pools: ["generic"],
      maxConcurrentRuns: 2,
      currentSessionIds: [],
      affinityKeys: ["session:session-failover-dispatch"],
      now: 0,
    });
    const claimedLease = await runStore.claimLease(
      "session-failover-dispatch",
      "worker-a",
      1_000,
    );
    expect(claimedLease.claimed).toBe(true);
    await runStore.enqueueDispatch({
      sessionId: "session-failover-dispatch",
      runId: "bg-failover-dispatch",
      pool: "generic",
      reason: "timer",
      createdAt: 1_000,
      availableAt: 1_000,
      dedupeKey: "dispatch:session-failover-dispatch:timer",
      preferredWorkerId: "worker-a",
      affinityKey: "session:session-failover-dispatch",
    });
    const claimedDispatch = await runStore.claimDispatchForWorker({
      workerId: "worker-a",
      pools: ["generic"],
      now: 1_000,
    });
    expect(claimedDispatch.claimed).toBe(true);
    expect(claimedDispatch.item?.claimOwnerId).toBe("worker-a");

    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "actor should not run for deterministic failover completion",
      }),
    );
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"state":"completed","userUpdate":"Standby worker finished the task after failover. Objective satisfied.","internalSummary":"reclaimed stale dispatch","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    vi.setSystemTime(25_000);
    await (supervisor as any).heartbeatWorker();
    await (supervisor as any).pumpDispatchQueue();

    await eventuallyAsync(async () => {
      const snapshot = await runStore.loadRecentSnapshot("session-failover-dispatch");
      expect(snapshot?.state).toBe("completed");
      expect(snapshot?.lastUserUpdate).toBe(
        "Browser download completed at /tmp/report.pdf. Objective satisfied.",
      );
    });
    expect(execute).not.toHaveBeenCalled();
    expect(supervisor.getStatusSnapshot("session-failover-dispatch")).toBeUndefined();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-failover-dispatch",
      "Browser download completed at /tmp/report.pdf. Objective satisfied.",
    );

    await supervisor.shutdown();
  });

  it.each([
    {
      label: "browser",
      record: makePersistedRunRecord({
        sessionId: "session-browser-recover",
        objective: "Download the report from the browser session.",
        contract: {
          domain: "browser",
          successCriteria: ["Download the report artifact."],
          completionCriteria: ["Observe the report download completing."],
          blockedCriteria: ["Browser automation fails."],
        },
        pendingSignals: [
          {
            id: "sig-browser-recover",
            type: "tool_result",
            content: "Browser download completed at /tmp/report.pdf.",
            timestamp: 2,
            data: {
              category: "browser",
              toolName: "mcp.browser.browser_download",
              artifactPath: "/tmp/report.pdf",
              failed: false,
            },
          },
        ],
      }),
      expectedUpdate: "Browser download completed at /tmp/report.pdf. Objective satisfied.",
    },
    {
      label: "desktop_gui",
      record: makePersistedRunRecord({
        sessionId: "session-desktop-gui-recover",
        objective: "Launch the desktop app window and confirm it is visible.",
        contract: {
          domain: "desktop_gui",
          successCriteria: ["Open the application window."],
          completionCriteria: ["Observe the window becoming visible."],
          blockedCriteria: ["Desktop launch fails."],
        },
        pendingSignals: [
          {
            id: "sig-desktop-gui-recover",
            type: "tool_result",
            content: "Application window launched and focused.",
            timestamp: 2,
            data: {
              toolName: "desktop.launch",
              failed: false,
            },
          },
        ],
      }),
      expectedUpdate: "Application window launched and focused. Objective satisfied.",
    },
    {
      label: "workspace",
      record: makePersistedRunRecord({
        sessionId: "session-workspace-recover",
        objective: "Run `git status --short` in the workspace and tell me when the command succeeds.",
        contract: {
          domain: "workspace",
          successCriteria: ["Execute the workspace command successfully."],
          completionCriteria: ["Verify the command succeeds in the workspace."],
          blockedCriteria: ["Workspace tooling is missing."],
        },
        pendingSignals: [
          {
            id: "sig-workspace-recover",
            type: "tool_result",
            content: "Tool result observed for desktop.bash.",
            timestamp: 2,
            data: {
              category: "generic",
              toolName: "desktop.bash",
              command: "git status --short",
              failed: false,
            },
          },
        ],
      }),
      expectedUpdate: "Tool result observed for desktop.bash. Objective satisfied.",
    },
    {
      label: "research",
      record: makePersistedRunRecord({
        sessionId: "session-research-recover",
        objective: "Research the vendor and save a short report.",
        contract: {
          domain: "research",
          successCriteria: ["Produce the report artifact."],
          completionCriteria: ["Persist the report to disk."],
          blockedCriteria: ["Research tools fail."],
        },
        pendingSignals: [
          {
            id: "sig-research-recover",
            type: "webhook",
            content: "Artifact watcher saved the research report.",
            timestamp: 2,
            data: {
              source: "artifact-watcher",
              path: "/tmp/research-report.md",
            },
          },
        ],
      }),
      expectedUpdate: "Artifact watcher saved the research report. Objective satisfied.",
    },
    {
      label: "pipeline",
      record: makePersistedRunRecord({
        sessionId: "session-pipeline-recover",
        objective: "Wait for the deployment pipeline to complete successfully.",
        contract: {
          domain: "pipeline",
          successCriteria: ["Observe the deployment pipeline complete."],
          completionCriteria: ["Receive a healthy completion signal."],
          blockedCriteria: ["The deployment pipeline becomes unhealthy."],
        },
        pendingSignals: [
          {
            id: "sig-pipeline-recover",
            type: "external_event",
            content: "Pipeline deploy-1 completed successfully.",
            timestamp: 2,
            data: {
              category: "health",
              eventType: "pipeline.completed",
              state: "completed",
              status: 200,
            },
          },
        ],
      }),
      expectedUpdate: "Pipeline deploy-1 completed successfully. Objective satisfied.",
    },
    {
      label: "remote_mcp",
      record: makePersistedRunRecord({
        sessionId: "session-remote-mcp-recover",
        objective: "Wait for the remote MCP job to finish successfully.",
        contract: {
          domain: "remote_mcp",
          successCriteria: ["Observe the remote MCP job complete."],
          completionCriteria: ["Receive a completion event from the remote server."],
          blockedCriteria: ["Remote MCP job fails."],
        },
        pendingSignals: [
          {
            id: "sig-remote-mcp-recover",
            type: "webhook",
            content: "MCP event observed from remote-job-server (job-42) completed successfully.",
            timestamp: 2,
            data: {
              category: "mcp",
              source: "remote-mcp-webhook",
              serverName: "remote-job-server",
              jobId: "job-42",
              state: "completed",
              status: 200,
            },
          },
        ],
      }),
      expectedUpdate:
        "MCP event observed from remote-job-server (job-42) completed successfully. Objective satisfied.",
    },
  ])(
    "recovers $label runs and completes deterministically from persisted evidence",
    async ({ record, expectedUpdate }) => {
      const tempDir = await mkdtemp(join(tmpdir(), "agenc-bg-run-domain-recover-"));
      const dbPath = join(tempDir, "memory.sqlite");

      try {
        const backend1 = new SqliteBackend({ dbPath });
        const runStore1 = new BackgroundRunStore({ memoryBackend: backend1 });
        await runStore1.saveRun(record);
        await backend1.close();

        const backend2 = new SqliteBackend({ dbPath });
        const runStore2 = new BackgroundRunStore({ memoryBackend: backend2 });
        const execute = vi.fn(async () => makeResult({ content: "actor should not run" }));
        const publishUpdate = vi.fn(async () => undefined);
        const supervisor = new BackgroundRunSupervisor({
          chatExecutor: { execute } as any,
          supervisorLlm: {
            name: "supervisor",
            chat: vi.fn(async () => ({
              content:
                '{"summary":"deterministic verifier should complete this without another model turn","verifiedFacts":[],"openLoops":[],"nextFocus":"None."}',
              toolCalls: [],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "supervisor-model",
              finishReason: "stop",
            })),
            chatStream: vi.fn(),
            healthCheck: vi.fn(async () => true),
          },
          getSystemPrompt: () => "base system prompt",
          runStore: runStore2,
          createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
          publishUpdate,
        });

        await expect(supervisor.recoverRuns()).resolves.toBe(1);
        await vi.advanceTimersByTimeAsync(0);

        await eventuallyAsync(async () => {
          const snapshot = await runStore2.loadRecentSnapshot(record.sessionId);
          expect(snapshot?.state).toBe("completed");
          expect(snapshot?.lastUserUpdate).toBe(expectedUpdate);
        });
        expect(execute).not.toHaveBeenCalled();
        expect(supervisor.getStatusSnapshot(record.sessionId)).toBeUndefined();
        expect(publishUpdate).toHaveBeenLastCalledWith(record.sessionId, expectedUpdate);

        await backend2.close();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("recovers approval-gated runs in blocked state until a durable approval wake arrives", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenc-bg-run-approval-recover-"));
    const dbPath = join(tempDir, "memory.sqlite");

    try {
      const backend1 = new SqliteBackend({ dbPath });
      const runStore1 = new BackgroundRunStore({ memoryBackend: backend1 });
      await runStore1.saveRun(
        makePersistedRunRecord({
          sessionId: "session-approval-recover",
          objective: "Wait for approval before deploying the change.",
          contract: {
            domain: "approval",
            successCriteria: ["Continue after approval."],
            completionCriteria: ["Receive approval from the operator."],
            blockedCriteria: ["Approval is still pending."],
          },
          state: "blocked",
          approvalState: {
            status: "waiting",
            requestId: "approval-123",
            requestedAt: 1,
            summary: "Waiting for deployment approval.",
          },
          blocker: {
            code: "approval_required",
            summary: "Waiting for deployment approval.",
            requiresOperatorAction: false,
            requiresApproval: true,
            since: 1,
          },
          pendingSignals: [],
        }),
      );
      await backend1.close();

      const backend2 = new SqliteBackend({ dbPath });
      const runStore2 = new BackgroundRunStore({ memoryBackend: backend2 });
      const execute = vi.fn(async () => makeResult({ content: "actor should not run" }));
      const supervisor = new BackgroundRunSupervisor({
        chatExecutor: { execute } as any,
        supervisorLlm: {
          name: "supervisor",
          chat: vi.fn(async () => ({
            content:
              '{"summary":"approval wait recovered","verifiedFacts":[],"openLoops":[],"nextFocus":"None."}',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: "supervisor-model",
            finishReason: "stop",
          })),
          chatStream: vi.fn(),
          healthCheck: vi.fn(async () => true),
        },
        getSystemPrompt: () => "base system prompt",
        runStore: runStore2,
        createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
        publishUpdate: vi.fn(async () => undefined),
      });

      await expect(supervisor.recoverRuns()).resolves.toBe(1);
      expect(supervisor.getStatusSnapshot("session-approval-recover")).toMatchObject({
        state: "blocked",
        objective: "Wait for approval before deploying the change.",
      });
      expect(execute).not.toHaveBeenCalled();
      await expect(runStore2.loadRun("session-approval-recover")).resolves.toMatchObject({
        state: "blocked",
        approvalState: {
          status: "waiting",
          requestedAt: 1,
          summary: "Waiting for deployment approval.",
        },
      });

      await backend2.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps blocked runs durable and resumes them when a new signal arrives", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Missing approval token.",
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Approval applied. Continuing work.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "proc_watcher" },
              result: '{"state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["continue until approved"],"completionCriteria":["verify the task resumes"],"blockedCriteria":["missing approval token"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"blocked","userUpdate":"Blocked waiting for the approval token.","internalSummary":"approval token missing","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Approval token received and the run resumed.","internalSummary":"resumed after approval","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-blocked",
      objective: "Keep monitoring this until the approval token arrives.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-blocked")?.state).toBe("blocked");
    await expect(runStore.loadRun("session-blocked")).resolves.toMatchObject({
      state: "blocked",
      blocker: expect.objectContaining({
        code: "approval_required",
        requiresApproval: true,
      }),
      approvalState: {
        status: "waiting",
        requestedAt: expect.any(Number),
        summary: "Blocked waiting for the approval token.",
      },
    });
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-blocked",
      "Blocked waiting for the approval token.",
    );

    const signalled = await supervisor.signalRun({
      sessionId: "session-blocked",
      content: "Approval token granted. Continue.",
    });
    expect(signalled).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatusSnapshot("session-blocked")?.state).toBe("working");
    await expect(runStore.loadRun("session-blocked")).resolves.toMatchObject({
      state: "working",
      blocker: undefined,
      approvalState: { status: "none" },
    });
  });

  it("queues user signals for an active run and carries forward compact state into the next cycle", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher started and verified.",
          toolCalls: [
            {
              name: "desktop.process_start",
              args: { label: "watcher" },
              result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher is still running and will now restart if it crashes.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "watcher" },
              result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process"],"completionCriteria":["observe the terminal state"],"blockedCriteria":["missing process tooling"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running and needs supervision.","verifiedFacts":["Watcher is running."],"openLoops":["Restart watcher if it crashes."],"nextFocus":"Monitor for process exit."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is still running and the crash-restart policy is active.","internalSummary":"updated from user signal","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running with a crash-restart instruction queued and applied.","verifiedFacts":["Watcher is running."],"openLoops":["Monitor for process exit and restart if needed."],"nextFocus":"Continue process supervision."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-signals",
      objective: "Monitor this process in the background and keep me updated.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-signals")?.carryForwardSummary).toBe(
      "Watcher is running and needs supervision.",
    );

    await supervisor.signalRun({
      sessionId: "session-signals",
      content: "If it crashes, restart it and keep monitoring.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(2);
    const secondPrompt = execute.mock.calls[1]?.[0].message.content ?? "";
    expect(secondPrompt).toContain("Carry-forward state:");
    expect(secondPrompt).toContain("Watcher is running and needs supervision.");
    expect(secondPrompt).toContain("Pending external signals:");
    expect(secondPrompt).toContain("If it crashes, restart it and keep monitoring.");
    expect(supervisor.getStatusSnapshot("session-signals")?.pendingSignals).toBe(1);
    expect(supervisor.getStatusSnapshot("session-signals")?.carryForwardSummary).toContain(
      "crash-restart instruction queued and applied",
    );
  await expect(
      (supervisor as any).runStore.loadRun("session-signals"),
    ).resolves.toMatchObject({
      watchRegistrations: [
        expect.objectContaining({
          kind: "managed_process",
          targetId: "proc_watcher",
        }),
      ],
      compaction: expect.objectContaining({
        refreshCount: 2,
      }),
      budgetState: expect.objectContaining({
        maxCycles: 512,
        nextCheckIntervalMs: 4000,
      }),
      fenceToken: expect.any(Number),
    });
  });

  it("does not execute an extra cycle when a late operator signal overlaps an expired timer dispatch", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ content: "Cycle 1 actor step." }))
      .mockResolvedValueOnce(makeResult({ content: "Cycle 2 actor step." }));
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"generic","kind":"until_stopped","successCriteria":["Keep making progress until stopped."],"completionCriteria":["Receive a stop request."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Cycle 1 complete.","internalSummary":"cycle 1","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Cycle 1 complete.","verifiedFacts":["Cycle 1 finished."],"openLoops":["Continue monitoring."],"nextFocus":"Run cycle 2."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Cycle 2 complete.","internalSummary":"cycle 2","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Cycle 2 complete.","verifiedFacts":["Cycle 2 finished."],"openLoops":["Continue monitoring."],"nextFocus":"Run cycle 3."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };
    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-late-signal",
      objective: "Keep monitoring for multiple hours until the operator stops the run.",
    });
    await eventually(() => {
      expect(supervisor.getStatusSnapshot("session-late-signal")).toMatchObject({
        state: "working",
        cycleCount: 1,
        lastUserUpdate: "Cycle 1 complete.",
      });
    });

    vi.setSystemTime(2 * 60 * 60 * 1000);
    await supervisor.signalRun({
      sessionId: "session-late-signal",
      content: "Continue cycle 2.",
    });
    await eventually(() => {
      expect(supervisor.getStatusSnapshot("session-late-signal")).toMatchObject({
        state: "working",
        cycleCount: 2,
        lastUserUpdate: "Cycle 2 complete.",
      });
    });

    expect(execute).toHaveBeenCalledTimes(2);
    await expect(runStore.getDispatchStats()).resolves.toMatchObject({
      totalQueued: 1,
      totalClaimed: 0,
    });
  });

  it("persists provider continuation anchors and reuses them on the next cycle", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher started and verified.",
          callUsage: [
            makeCallUsageRecord({
              statefulDiagnostics: {
                enabled: true,
                attempted: false,
                continued: false,
                store: true,
                fallbackToStateless: true,
                responseId: "resp_cycle_1",
                reconciliationHash: "hash_cycle_1",
                events: [],
              },
            }),
          ],
          toolCalls: [
            {
              name: "desktop.process_start",
              args: { label: "watcher" },
              result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher is still running.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "proc_watcher" },
              result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["keep the watcher running"],"completionCriteria":["observe the watcher exit"],"blockedCriteria":["missing process controls"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running.","verifiedFacts":["Watcher started."],"openLoops":["Wait for process exit."],"nextFocus":"Continue monitoring."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher still running.","internalSummary":"verified running again","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is still running.","verifiedFacts":["Watcher is running."],"openLoops":["Wait for process exit."],"nextFocus":"Keep monitoring."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-stateful-anchor",
      objective: "Monitor the watcher in the background and keep it running.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(runStore.loadRun("session-stateful-anchor")).resolves.toMatchObject({
      carryForward: expect.objectContaining({
        providerContinuation: expect.objectContaining({
          provider: "grok",
          responseId: "resp_cycle_1",
          reconciliationHash: "hash_cycle_1",
          mode: "previous_response_id",
        }),
      }),
      compaction: expect.objectContaining({
        lastProviderAnchorAt: expect.any(Number),
      }),
    });

    await supervisor.signalRun({
      sessionId: "session-stateful-anchor",
      content: "Check it again.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      stateful: {
        resumeAnchor: {
          previousResponseId: "resp_cycle_1",
          reconciliationHash: "hash_cycle_1",
        },
      },
    });
  });

  it("repairs poisoned carry-forward summaries that drift from verified evidence", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher started.",
          toolCalls: [
            {
              name: "desktop.process_start",
              args: { label: "watcher" },
              result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Latest status probe failed and will retry.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "proc_watcher" },
              result: "process lookup failed",
              isError: true,
              durationMs: 5,
            },
          ],
        }),
      );
    const poisonedSummary =
      "The watcher completed successfully and the objective is fully satisfied.";
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["keep watching the process"],"completionCriteria":["observe the watcher exit"],"blockedCriteria":["missing process controls"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running.","verifiedFacts":["Watcher started."],"openLoops":["Wait for process exit."],"nextFocus":"Keep monitoring."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Latest status probe failed and will retry.","internalSummary":"probe failed","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            `{"summary":"${poisonedSummary}","verifiedFacts":["Watcher completed successfully."],"openLoops":[],"nextFocus":"None."}`,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-carry-repair",
      objective: "Monitor the watcher in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.signalRun({
      sessionId: "session-carry-repair",
      content: "Check it again now.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(runStore.loadRun("session-carry-repair")).resolves.toMatchObject({
      carryForward: expect.objectContaining({
        summaryHealth: expect.objectContaining({
          status: "repairing",
          driftCount: 1,
          lastDriftReason: "carry_forward_claims_success_after_error_cycle",
        }),
      }),
      compaction: expect.objectContaining({
        lastCompactionReason: "repair",
        repairCount: 1,
      }),
    });
    const repaired = await runStore.loadRun("session-carry-repair");
    expect(repaired?.carryForward?.summary).not.toBe(poisonedSummary);
  });

  it("stores provider compaction artifacts out of band and traces them on memory refresh", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Watcher launched and compacted provider state was returned.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: { label: "watcher" },
            result: '{"processId":"proc_watcher","label":"watcher","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
        callUsage: [
          makeCallUsageRecord({
            provider: "grok",
            statefulDiagnostics: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              responseId: "resp_compacted",
              reconciliationHash: "hash_compacted",
            },
            compactionDiagnostics: {
              enabled: true,
              requested: true,
              active: true,
              mode: "server_side_context_management",
              threshold: 12_000,
              observedItemCount: 1,
              latestItem: {
                type: "compaction",
                id: "cmp_1",
                digest: "deadbeefcafebabe",
              },
            },
          }),
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process"],"completionCriteria":["observe it exit"],"blockedCriteria":["missing process controls"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher launched.","internalSummary":"watcher launched","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher launched and needs monitoring.","verifiedFacts":["Watcher process launched."],"openLoops":["Wait for process exit."],"nextFocus":"Keep monitoring the watcher."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-provider-compaction",
      objective: "Monitor the watcher in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const run = await runStore.loadRun("session-provider-compaction");
    expect(run).toMatchObject({
      carryForward: expect.objectContaining({
        providerContinuation: expect.objectContaining({
          responseId: "resp_compacted",
        }),
        artifacts: [
          expect.objectContaining({
            kind: "process",
            locator: "proc_watcher",
          }),
          expect.objectContaining({
            kind: "opaque_provider_state",
            locator: "provider:grok:compaction:cmp_1",
            source: "grok:context_management",
            digest: "deadbeefcafebabe",
          }),
        ],
      }),
    });

    const compactionEvent = (await runStore.listEvents(run!.id)).find((event) =>
      event.metadata?.eventType === "memory_compacted"
    );
    expect(compactionEvent?.metadata).toMatchObject({
      eventType: "memory_compacted",
      providerCompactionArtifact: "provider:grok:compaction:cmp_1",
      providerCompactionDigest: "deadbeefcafebabe",
    });
  });

  it("keeps binary tool outputs out of band when recording carry-forward evidence", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const binaryPayload = `data:image/png;base64,${"A".repeat(900)}`;
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Captured a screenshot for later verification.",
        toolCalls: [
          {
            name: "desktop.screenshot",
            args: {},
            result: binaryPayload,
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["capture screenshot evidence"],"completionCriteria":["observe the expected GUI state"],"blockedCriteria":["desktop tooling missing"],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Screenshot captured.","internalSummary":"captured screenshot evidence","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Screenshot captured for later verification.","verifiedFacts":["GUI screenshot captured."],"openLoops":["Verify the GUI state."],"nextFocus":"Inspect the screenshot evidence."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const runStore = createRunStore();
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-binary-evidence",
      objective: "Capture screenshot evidence in the background.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const run = await runStore.loadRun("session-binary-evidence");
    expect(run?.lastToolEvidence).toContain("binary artifact omitted");
    expect(run?.lastToolEvidence).not.toContain(binaryPayload);
    expect(run?.carryForward?.artifacts).toEqual([
      expect.objectContaining({
        kind: "opaque_provider_state",
        source: "desktop.screenshot",
        digest: expect.any(String),
      }),
    ]);
  });

  it("completes deterministically from a verified process_exit signal when the objective is satisfied", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Watcher started.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: { label: "watcher" },
            result: '{"processId":"proc_watcher","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process until it exits"],"completionCriteria":["observe the process exit"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running until exit is observed.","verifiedFacts":["Watcher is running."],"openLoops":["Wait for process exit."],"nextFocus":"Observe exit state."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-process-complete",
      objective: "Monitor this process in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-process-complete")?.state).toBe("working");

    await supervisor.signalRun({
      sessionId: "session-process-complete",
      type: "process_exit",
      content: 'Managed process "watcher" (proc_watcher) exited (exitCode=0).',
    });

    await eventually(() => {
      expect(supervisor.getStatusSnapshot("session-process-complete")).toBeUndefined();
    });
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-process-complete",
      'Managed process "watcher" (proc_watcher) exited (exitCode=0). Objective satisfied.',
    );
  });

  it("wakes immediately on process_exit signals and restarts a managed process natively", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Watcher started.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "watcher",
            },
            result:
              '{"processId":"proc_watcher","label":"watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const nativeTools = createManagedProcessToolHandler();
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process"],"completionCriteria":["observe the terminal state"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"restart_on_exit","maxRestarts":3,"restartBackoffMs":2000}}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running.","verifiedFacts":["Watcher is running."],"openLoops":["Monitor for process exit."],"nextFocus":"Wait for process events."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher exited once and was restarted by the runtime.","verifiedFacts":["Watcher exited.","Watcher restarted successfully."],"openLoops":["Verify the restarted watcher stays up."],"nextFocus":"Confirm the restarted process is healthy."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => nativeTools.handler,
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-process-exit",
      objective: "Monitor this process in the background and recover on exit.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    nativeTools.markExited(0);

    await supervisor.signalRun({
      sessionId: "session-process-exit",
      type: "process_exit",
      content: 'Managed process "watcher" (proc_watcher) exited (exitCode=0).',
      data: { processId: "proc_watcher", exitCode: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(nativeTools.handler).toHaveBeenNthCalledWith(
      1,
      "desktop.process_status",
      { label: "watcher" },
    );
    expect(nativeTools.handler).toHaveBeenNthCalledWith(
      2,
      "desktop.process_start",
      {
        command: "/bin/sleep",
        args: ["2"],
        cwd: "/tmp",
        label: "watcher",
      },
    );

    await eventually(() => {
      const snapshot = supervisor.getStatusSnapshot("session-process-exit");
      expect(snapshot?.state).toBe("working");
      expect(snapshot?.lastUserUpdate).toContain("Restarted");
      expect(snapshot?.lastUserUpdate).toContain("proc_watcher_2");
    });
  });

  it("restarts host managed-process runs with the host durable process tool family", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Host watcher started.",
        toolCalls: [
          {
            name: "system.processStart",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "host-watcher",
            },
            result:
              '{"processId":"proc_watcher","label":"host-watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const nativeTools = createManagedProcessToolHandler({
      surface: "host",
      label: "host-watcher",
    });
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the host process"],"completionCriteria":["observe the terminal state"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"restart_on_exit","maxRestarts":3,"restartBackoffMs":2000}}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Host watcher is running.","internalSummary":"verified running","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Host watcher is running.","verifiedFacts":["Host watcher is running."],"openLoops":["Monitor for process exit."],"nextFocus":"Wait for process events."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Host watcher exited once and was restarted by the runtime.","verifiedFacts":["Host watcher exited.","Host watcher restarted successfully."],"openLoops":["Verify the restarted watcher stays up."],"nextFocus":"Confirm the restarted process is healthy."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => nativeTools.handler,
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-host-process-exit",
      objective: "Monitor this host process in the background and recover on exit.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    nativeTools.markExited(0);

    await supervisor.signalRun({
      sessionId: "session-host-process-exit",
      type: "process_exit",
      content: 'Managed process "host-watcher" (proc_watcher) exited (exitCode=0).',
      data: { processId: "proc_watcher", exitCode: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(nativeTools.handler).toHaveBeenNthCalledWith(
      1,
      nativeTools.toolNames.status,
      { label: "host-watcher" },
    );
    expect(nativeTools.handler).toHaveBeenNthCalledWith(
      2,
      nativeTools.toolNames.start,
      {
        command: "/bin/sleep",
        args: ["2"],
        cwd: "/tmp",
        label: "host-watcher",
      },
    );

    await eventually(() => {
      const snapshot = supervisor.getStatusSnapshot("session-host-process-exit");
      expect(snapshot?.state).toBe("working");
      expect(snapshot?.lastUserUpdate).toContain("Restarted");
      expect(snapshot?.lastUserUpdate).toContain("proc_watcher_2");
    });
  });

  it("uses native managed-process verification on timer wakes after the initial actor cycle", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Sleep watcher started.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "watcher",
            },
            result:
              '{"processId":"proc_watcher","label":"watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const nativeTools = createManagedProcessToolHandler();
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process until it exits"],"completionCriteria":["observe the process exit"],"blockedCriteria":["missing process tooling"],"nextCheckMs":4000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher started successfully.","verifiedFacts":["Watcher is running."],"openLoops":["Wait for process exit."],"nextFocus":"Verify the process stays up."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is still running after native verification.","verifiedFacts":["Watcher is still running."],"openLoops":["Wait for process exit."],"nextFocus":"Run another status probe later."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => nativeTools.handler,
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-native-probe",
      objective: "Monitor this process in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(nativeTools.handler).toHaveBeenCalledWith(
      "desktop.process_status",
      { label: "watcher" },
    );

    const snapshot = supervisor.getStatusSnapshot("session-native-probe");
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.lastUserUpdate).toContain("still running");
  });

  it("rejects optimistic completion claims when the managed-process domain verifies the process is still running", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Watcher started successfully.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "watcher",
            },
            result:
              '{"processId":"proc_watcher","label":"watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process until it exits"],"completionCriteria":["observe the process exit"],"blockedCriteria":["missing process tooling"],"nextCheckMs":4000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running.","verifiedFacts":["Watcher is running."],"openLoops":["Wait for process exit."],"nextFocus":"Verify process status again."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-managed-process-grounding",
      objective: "Monitor this process in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = supervisor.getStatusSnapshot(
      "session-managed-process-grounding",
    );
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.lastUserUpdate).toContain("still running");
    expect(supervisor.hasActiveRun("session-managed-process-grounding")).toBe(true);
  });

  it("rejects optimistic browser completion claims when only navigation evidence exists", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Opened the report page.",
        toolCalls: [
          {
            name: "mcp.browser.browser_navigate",
            args: {
              url: "https://example.com/report",
            },
            result:
              '{"url":"https://example.com/report","title":"Quarterly Report"}',
            isError: false,
            durationMs: 6,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"browser","kind":"finite","successCriteria":["Download the report artifact."],"completionCriteria":["Observe the report download completing."],"blockedCriteria":["Browser automation fails."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"completed","userUpdate":"The report download is complete.","internalSummary":"done","shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The report page is open but the download has not happened yet.","verifiedFacts":["The report page loaded successfully."],"openLoops":["Trigger and verify the report download."],"nextFocus":"Download the report artifact."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-browser-grounding",
      objective: "Download the report from the browser session.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = supervisor.getStatusSnapshot("session-browser-grounding");
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.lastUserUpdate).toContain("Browser navigation completed");
    expect(supervisor.hasActiveRun("session-browser-grounding")).toBe(true);
  });

  it("completes workspace runs deterministically from internal command evidence", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Ran the workspace test suite.",
        toolCalls: [
          {
            name: "system.bash",
            args: {
              command: "npm",
              args: ["test"],
            },
            result: '{"stdout":"all tests passed\\n","stderr":"","exitCode":0}',
            isError: false,
            durationMs: 11,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"generic","kind":"finite","successCriteria":["Execute the workspace tests."],"completionCriteria":["Verify the test command succeeds."],"blockedCriteria":["Workspace tooling is missing."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The workspace test command completed successfully.","verifiedFacts":["npm test succeeded."],"openLoops":[],"nextFocus":"None."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-workspace-complete",
      objective: "Run the workspace test suite successfully.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-workspace-complete")).toBeUndefined();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-workspace-complete",
      "Tool result observed for system.bash. Objective satisfied.",
    );
  });

  it("completes explicit finite workspace commands through the native workspace domain without actor tool planning", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn();
    const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("system.bash");
      expect(args).toEqual({
        command: "git",
        args: ["status", "--short"],
      });
      return '{"stdout":"","stderr":"","exitCode":0}';
    });
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"generic","kind":"until_condition","successCriteria":["Execute the workspace command successfully."],"completionCriteria":["Verify the command succeeds in the workspace."],"blockedCriteria":["Workspace tooling is missing."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The workspace command completed successfully.","verifiedFacts":["git status --short succeeded."],"openLoops":[],"nextFocus":"None."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => toolHandler,
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-workspace-native",
      objective: "Run `git status --short` in the workspace and tell me when the command succeeds.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(supervisor.getStatusSnapshot("session-workspace-native")).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-workspace-native",
      "Workspace command `git status --short` succeeded. Objective satisfied.",
    );
  });

  it("rejects false workspace success claims that have no verified tool evidence", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Objective satisfied. The workspace command succeeded.",
        toolCalls: [],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"workspace","kind":"finite","successCriteria":["Execute the workspace validation successfully."],"completionCriteria":["Verify the workspace command succeeds."],"blockedCriteria":["Workspace tooling is missing."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"completed","userUpdate":"Objective satisfied. The workspace command succeeded.","internalSummary":"model claimed success","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"No verified workspace evidence exists yet.","verifiedFacts":[],"openLoops":["Run a command or produce a file change."],"nextFocus":"Obtain verified workspace evidence."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-workspace-false-success",
      objective: "Validate the workspace command succeeds and report when finished.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot =
      supervisor.getStatusSnapshot("session-workspace-false-success") ??
      await supervisor.getRecentSnapshot("session-workspace-false-success");
    expect(snapshot?.state).toBe("blocked");
    expect(snapshot?.lastUserUpdate).toBe(
      "Background run cannot mark itself complete without verified tool evidence.",
    );
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-workspace-false-success",
      "Background run cannot mark itself complete without verified tool evidence.",
    );
  });

  it("completes browser runs from download events without spending another actor cycle", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Opened the report page.",
        toolCalls: [
          {
            name: "mcp.browser.browser_navigate",
            args: { url: "https://example.com/report" },
            result:
              '{"url":"https://example.com/report","title":"Quarterly Report"}',
            isError: false,
            durationMs: 6,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"browser","kind":"finite","successCriteria":["Download the report artifact."],"completionCriteria":["Observe the report download completing."],"blockedCriteria":["Browser automation fails."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"The report page is open.","internalSummary":"browser session ready","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The report page is open and waiting for a download event.","verifiedFacts":["The report page loaded."],"openLoops":["Wait for the report download."],"nextFocus":"Observe the browser download event."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The browser download event completed the run.","verifiedFacts":["The report download completed."],"openLoops":[],"nextFocus":"None."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-browser-download",
      objective: "Download the report from the browser session.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-browser-download")?.state).toBe("working");

    await supervisor.signalRun({
      sessionId: "session-browser-download",
      type: "external_event",
      content: "Browser download completed at /tmp/report.pdf.",
      data: {
        eventType: "browser.download.completed",
        path: "/tmp/report.pdf",
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-browser-download")).toBeUndefined();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-browser-download",
      "Browser download completed at /tmp/report.pdf. Objective satisfied.",
    );
  });

  it("uses signal-preferred retry cadence for browser runs when no new tool evidence arrives", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Still waiting for the browser page to change.",
        toolCalls: [],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"browser","kind":"until_condition","successCriteria":["Open the browser page."],"completionCriteria":["Observe the page reach the requested state."],"blockedCriteria":["Browser automation fails."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Still waiting for browser evidence.","internalSummary":"browser waiting","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Waiting for the browser page to change.","verifiedFacts":[],"openLoops":["Wait for browser evidence."],"nextFocus":"Observe the page state."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-browser-retry-policy",
      objective: "Keep watching the browser page until the target state appears.",
    });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = supervisor.getStatusSnapshot("session-browser-retry-policy");
    expect(snapshot?.state).toBe("working");
    expect((snapshot?.nextCheckAt ?? 0) - (snapshot?.updatedAt ?? 0)).toBe(15_000);
  });

  it("completes remote MCP runs from callback events without another actor cycle", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValueOnce(
      makeResult({
        content: "Started the remote MCP job.",
        toolCalls: [
          {
            name: "mcp.remote.jobs_start",
            args: { query: "generate report" },
            result:
              '{"jobId":"job-42","serverName":"remote-job-server","state":"running"}',
            isError: false,
            durationMs: 9,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"remote_mcp","kind":"finite","successCriteria":["Observe the remote MCP job complete."],"completionCriteria":["Receive a completion event from the remote server."],"blockedCriteria":["Remote MCP job fails."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"The remote MCP job is running.","internalSummary":"waiting for callback","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The remote MCP job is running and waiting for a callback.","verifiedFacts":["Remote MCP job job-42 started."],"openLoops":["Wait for remote completion callback."],"nextFocus":"Observe the remote MCP event."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"The remote MCP callback completed the run.","verifiedFacts":["Remote MCP job job-42 completed."],"openLoops":[],"nextFocus":"None."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-remote-mcp-complete",
      objective: "Wait for the remote MCP job to finish.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-remote-mcp-complete")?.state).toBe("working");

    await supervisor.signalRun({
      sessionId: "session-remote-mcp-complete",
      type: "tool_result",
      content: "Remote MCP job job-42 completed successfully.",
      data: {
        category: "mcp",
        serverName: "remote-job-server",
        jobId: "job-42",
        state: "completed",
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-remote-mcp-complete")).toBeUndefined();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-remote-mcp-complete",
      "Remote MCP job job-42 completed successfully. Objective satisfied.",
    );
  });

  it("defers new dispatches under queue saturation by scheduling admission_retry work", async () => {
    const runStore = createRunStore();
    await runStore.heartbeatWorker({
      workerId: "foreign-generic-worker",
      pools: ["generic"],
      maxConcurrentRuns: 1,
      now: 0,
    });
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        runStore.enqueueDispatch({
          sessionId: `session-saturated-${index}`,
          runId: `bg-saturated-${index}`,
          pool: "generic",
          reason: "timer",
          createdAt: 1,
          availableAt: 1,
          dedupeKey: `dispatch:saturated:${index}`,
          preferredWorkerId: "foreign-generic-worker",
        }),
      ),
    );

    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValue(makeResult({ content: "Should not run yet." }));
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm: {
        name: "supervisor",
        chat: vi.fn(async () => ({
          content:
            '{"domain":"generic","kind":"finite","successCriteria":["Complete the task."],"completionCriteria":["Observe success."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })),
        chatStream: vi.fn(),
        healthCheck: vi.fn(async () => true),
      },
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-admission",
      objective: "Run this generic background task.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(0);
    const dispatchQueue = await runStore.loadDispatchQueue();
    expect(dispatchQueue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-admission",
          reason: "admission_retry",
        }),
      ]),
    );
  });

  it("completes deterministically from managed process status without waiting for an exit event", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Watcher reached its terminal state.",
        toolCalls: [
          {
            name: "desktop.process_status",
            args: { processId: "proc_watcher" },
            result: '{"processId":"proc_watcher","label":"watcher","state":"exited","exitCode":0}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process until it exits"],"completionCriteria":["observe the process exit"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher reached exited state.","verifiedFacts":["Watcher exited."],"openLoops":[],"nextFocus":"None."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-status-terminal",
      objective: "Monitor this process in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-status-terminal")).toBeUndefined();
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-status-terminal",
      'Managed process "watcher" (proc_watcher) exited. Objective satisfied.',
    );
  });

  it("completes from a process_exit signal that arrives during carry-forward refresh", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const carryForwardReply = deferred<{
      content: string;
      toolCalls: never[];
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      model: string;
      finishReason: "stop";
    }>();
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Watcher started.",
        toolCalls: [
          {
            name: "desktop.process_start",
            args: { label: "watcher" },
            result: '{"processId":"proc_watcher","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["watch the process until it exits"],"completionCriteria":["observe the process exit"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockImplementationOnce(() => carryForwardReply.promise),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-process-tail-exit",
      objective: "Monitor this process in the background until it exits.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatusSnapshot("session-process-tail-exit")?.state).toBe("running");

    await supervisor.signalRun({
      sessionId: "session-process-tail-exit",
      type: "process_exit",
      content: 'Managed process "watcher" (proc_watcher) exited (exitCode=0).',
    });

    carryForwardReply.resolve({
      content:
        '{"summary":"Watcher launch verified.","verifiedFacts":["Watcher started."],"openLoops":["Wait for process exit."],"nextFocus":"Observe exit."}',
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "supervisor-model",
      finishReason: "stop",
    });
    await eventually(() => {
      expect(supervisor.getStatusSnapshot("session-process-tail-exit")).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(publishUpdate).toHaveBeenCalledWith(
        "session-process-tail-exit",
        'Managed process "watcher" (proc_watcher) exited (exitCode=0). Objective satisfied.',
      );
    });
  });

  it("preserves late external signals that arrive during carry-forward refresh", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const carryForwardReply = deferred<{
      content: string;
      toolCalls: never[];
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      model: string;
      finishReason: "stop";
    }>();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Watcher started.",
          toolCalls: [
            {
              name: "desktop.process_start",
              args: { label: "watcher" },
              result: '{"processId":"proc_watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "Observed the new external signal and captured it.",
          toolCalls: [
            {
              name: "desktop.process_status",
              args: { processId: "proc_watcher" },
              result: '{"processId":"proc_watcher","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        }),
      );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"kind":"until_condition","successCriteria":["monitor the process and react to external events"],"completionCriteria":["observe the requested terminal state"],"blockedCriteria":["missing process tooling"],"nextCheckMs":60000,"heartbeatMs":15000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockImplementationOnce(() => carryForwardReply.promise)
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Captured the external signal and will keep monitoring.","internalSummary":"reacted to external signal","nextCheckMs":60000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Watcher is running and the external signal was handled.","verifiedFacts":["Watcher is running.","External warning captured."],"openLoops":["Continue monitoring watcher health."],"nextFocus":"Wait for the next external event."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-late-external-signal",
      objective: "Monitor this process in the background and react to external signals.",
    });
    await vi.advanceTimersByTimeAsync(0);

    await supervisor.signalRun({
      sessionId: "session-late-external-signal",
      type: "external_event",
      content: "A webhook reported a warning from the watcher process.",
    });

    carryForwardReply.resolve({
      content:
        '{"summary":"Watcher launch verified.","verifiedFacts":["Watcher started."],"openLoops":["Monitor for process health changes."],"nextFocus":"Wait for external events."}',
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "supervisor-model",
      finishReason: "stop",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
    expect(execute.mock.calls[1]?.[0].message.content).toContain(
      "A webhook reported a warning from the watcher process.",
    );
    expect(publishUpdate).not.toHaveBeenCalledWith(
      "session-late-external-signal",
      "Watcher is running.",
    );
  });

  it("fails a run when the scoped token budget is exhausted", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          content: "Still monitoring.",
          tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
          callUsage: [
            makeCallUsageRecord({
              usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          content: "This second cycle should trip the budget.",
          tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
          callUsage: [
            makeCallUsageRecord({
              usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
            }),
          ],
        }),
      );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"generic","kind":"finite","successCriteria":["Keep checking."],"completionCriteria":["Observe deterministic completion."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":2000,"heartbeatMs":12000,"requiresUserStop":false}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        })
        .mockResolvedValue({
          content:
            '{"state":"working","userUpdate":"Still monitoring.","internalSummary":"waiting","nextCheckMs":2000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore: createRunStore(),
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
      policyEngine: new PolicyEngine({
        policy: {
          enabled: true,
          scopedTokenBudgets: {
            run: {
              limitTokens: 8,
              windowMs: 60_000,
            },
          },
        },
      }),
      resolvePolicyScope: ({ runId }) => ({ runId }),
    });

    await supervisor.startRun({
      sessionId: "session-token-budget",
      objective: "Keep monitoring in the background.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await eventually(() => {
      expect(supervisor.getStatusSnapshot("session-token-budget")).toBeUndefined();
    });
    expect(publishUpdate).toHaveBeenLastCalledWith(
      "session-token-budget",
      "Background run exhausted its token budget before the objective completed.",
    );
  });

  it("waits when the managed-process concurrency budget is saturated", async () => {
    const publishUpdate = vi.fn(async () => undefined);
    const execute = vi.fn().mockResolvedValue(
      makeResult({
        content: "Still monitoring.",
      }),
    );
    const supervisorLlm: LLMProvider = {
      name: "supervisor",
      chat: vi
        .fn()
        .mockResolvedValue({
          content:
            '{"state":"working","userUpdate":"Still monitoring.","internalSummary":"waiting","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "supervisor-model",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };
    const runStore = createRunStore();
    await runStore.saveRun(
      makePersistedRunRecord({
        sessionId: "session-process-budget",
        objective: "Monitor this process until it exits.",
        contract: {
          domain: "generic",
          kind: "finite",
          successCriteria: ["Keep monitoring."],
          completionCriteria: ["Observe deterministic completion."],
          blockedCriteria: ["Runtime unavailable."],
          nextCheckMs: 4_000,
          heartbeatMs: 12_000,
          requiresUserStop: false,
          managedProcessPolicy: { mode: "none" },
        },
        observedTargets: [
          {
            kind: "managed_process",
            processId: "proc_watcher",
            label: "watcher",
            desiredState: "exited",
            exitPolicy: "until_exit",
            currentState: "running",
            lastObservedAt: 1,
          },
        ],
      }),
    );
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
      runStore,
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
      policyEngine: new PolicyEngine({
        policy: {
          enabled: true,
          scopedProcessBudgets: {
            run: {
              maxConcurrent: 0,
            },
          },
        },
      }),
      resolvePolicyScope: ({ runId }) => ({ runId }),
    });

    await supervisor.recoverRuns();
    await vi.advanceTimersByTimeAsync(20);

    const snapshot = supervisor.getStatusSnapshot("session-process-budget");
    expect(snapshot?.state).toBe("working");
    await eventually(() => {
      expect(publishUpdate).toHaveBeenCalledWith(
        "session-process-budget",
        "Background run is waiting for available managed-process capacity (run scope).",
      );
    });
    expect(execute).not.toHaveBeenCalled();

    const persisted = await runStore.loadRun("session-process-budget");
    expect(persisted?.policyScope).toMatchObject({
      sessionId: "session-process-budget",
      tenantId: "tenant-a",
      projectId: "project-x",
      runId: "run-bg-persisted",
    });
    expect(persisted?.budgetState.managedProcessCount).toBe(1);
  });
});
