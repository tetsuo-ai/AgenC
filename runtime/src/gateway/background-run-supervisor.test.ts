import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import {
  BackgroundRunSupervisor,
  inferBackgroundRunIntent,
  isBackgroundRunStatusRequest,
  isBackgroundRunStopRequest,
} from "./background-run-supervisor.js";

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
      createToolHandler: (): ToolHandler => vi.fn(async () => "ok"),
      publishUpdate,
    });

    await supervisor.startRun({
      sessionId: "session-grounded",
      objective: "Play Doom until I say stop and keep me updated.",
    });
    await vi.runOnlyPendingTimersAsync();

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
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };

    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: { execute } as any,
      supervisorLlm,
      getSystemPrompt: () => "base system prompt",
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
});
