import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import {
  BackgroundRunSupervisor,
  inferBackgroundRunIntent,
  isBackgroundRunPauseRequest,
  isBackgroundRunResumeRequest,
  isBackgroundRunStatusRequest,
  isBackgroundRunStopRequest,
} from "./background-run-supervisor.js";
import { BackgroundRunStore } from "./background-run-store.js";

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

function createManagedProcessToolHandler(params?: {
  readonly initialProcessId?: string;
  readonly label?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}) {
  const state = {
    processId: params?.initialProcessId ?? "proc_watcher",
    label: params?.label ?? "watcher",
    command: params?.command ?? "/bin/sleep",
    args: [...(params?.args ?? ["2"])],
    cwd: params?.cwd ?? "/tmp",
    currentState: "running" as "running" | "exited",
    exitCode: 0 as number | null,
    restartCount: 0,
  };

  const handler = vi.fn<ToolHandler>(async (name, args) => {
    if (name === "desktop.process_status") {
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
    if (name === "desktop.process_start") {
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
  };
}

describe("background-run-supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    await vi.runOnlyPendingTimersAsync();

    expect(execute).toHaveBeenCalledTimes(1);
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
    expect(supervisor.getStatusSnapshot("session-pause-resume")?.pendingSignals).toBe(1);
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

  it("publishes a runtime heartbeat while a stable background run waits for the next verification", async () => {
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
    await vi.advanceTimersByTimeAsync(10_000);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(publishUpdate).toHaveBeenNthCalledWith(
      3,
      "session-heartbeat",
      expect.stringContaining("Still working in the background."),
    );

    const snapshot = supervisor.getStatusSnapshot("session-heartbeat");
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
                result: '{"state":"running"}',
                isError: false,
                durationMs: 4,
              },
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
      expect((await runStore1.listRuns()).length).toBe(1);
      await supervisor1.shutdown();
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
              result: '{"state":"running"}',
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
      expect(supervisor2.getStatusSnapshot("session-recover")?.state).toBe("working");

      await vi.advanceTimersByTimeAsync(0);
      expect(execute2).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(execute2).toHaveBeenCalledTimes(2);
      await backend2.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
              result: '{"state":"running"}',
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
    expect(supervisor.getStatusSnapshot("session-signals")?.pendingSignals).toBe(0);
    expect(supervisor.getStatusSnapshot("session-signals")?.carryForwardSummary).toContain(
      "crash-restart instruction queued and applied",
    );
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

    expect(supervisor.getStatusSnapshot("session-process-complete")).toBeUndefined();
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

    const snapshot = supervisor.getStatusSnapshot("session-process-exit");
    expect(snapshot?.state).toBe("working");
    expect(snapshot?.lastUserUpdate).toContain("Restarted");
    expect(snapshot?.lastUserUpdate).toContain("proc_watcher_2");
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
});
