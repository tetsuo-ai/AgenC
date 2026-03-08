import { describe, expect, it, vi } from "vitest";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { BackgroundRunStore } from "../gateway/background-run-store.js";
import { BackgroundRunSupervisor } from "../gateway/background-run-supervisor.js";
import { runBackgroundRunQualitySuite } from "./background-run-quality-runner.js";

function makeActorResult(content: string, tokenCount: number): ChatExecutorResult {
  return {
    content,
    provider: "background-run-quality-test",
    model: "background-run-quality-test",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: {
      promptTokens: Math.max(1, Math.floor(tokenCount / 2)),
      completionTokens: Math.max(1, tokenCount - Math.max(1, Math.floor(tokenCount / 2))),
      totalTokens: tokenCount,
    },
    callUsage: [],
    durationMs: 5,
    compacted: false,
    stopReason: "completed",
  };
}

async function flushBackgroundWork(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForSnapshot(
  supervisor: BackgroundRunSupervisor,
  sessionId: string,
  predicate: (snapshot: NonNullable<ReturnType<BackgroundRunSupervisor["getStatusSnapshot"]>>) => boolean,
  attempts = 40,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await flushBackgroundWork();
    const snapshot = supervisor.getStatusSnapshot(sessionId);
    if (snapshot && predicate(snapshot)) {
      return;
    }
  }
  throw new Error(`Timed out waiting for background run snapshot ${sessionId}`);
}

describe("background-run-quality runner", () => {
  it("runs the benchmark suite and returns a valid artifact", async () => {
    const artifact = await runBackgroundRunQualitySuite({
      runId: "background-run-quality-runner-test",
    });

    expect(artifact.runId).toBe("background-run-quality-runner-test");
    expect(artifact.runCount).toBeGreaterThanOrEqual(6);
    expect(artifact.canaryRuns).toBeGreaterThan(0);
    expect(artifact.soakRuns).toBeGreaterThan(0);
    expect(artifact.chaosRuns).toBeGreaterThan(0);
    expect(artifact.replayInconsistencies).toBe(0);
  });

  it("supports deterministic multi-hour soak supervision with virtual time", async () => {
    let currentTime = 0;
    const now = () => currentTime;
    const store = new BackgroundRunStore({
      memoryBackend: new InMemoryBackend(),
    });
    const supervisorLlm: LLMProvider = {
      name: "background-run-soak-test",
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content:
            '{"domain":"generic","kind":"until_stopped","successCriteria":["Keep making progress until stopped."],"completionCriteria":["Receive a stop request."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Cycle 1 complete.","internalSummary":"cycle 1","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Cycle 1 complete.","verifiedFacts":["Cycle 1 finished."],"openLoops":["Continue monitoring."],"nextFocus":"Run cycle 2."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Cycle 2 complete.","internalSummary":"cycle 2","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Cycle 2 complete.","verifiedFacts":["Cycle 2 finished."],"openLoops":["Continue monitoring."],"nextFocus":"Run cycle 3."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"state":"working","userUpdate":"Cycle 3 complete.","internalSummary":"cycle 3","nextCheckMs":4000,"shouldNotifyUser":true}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content:
            '{"summary":"Cycle 3 complete.","verifiedFacts":["Cycle 3 finished."],"openLoops":["Await operator stop."],"nextFocus":"Keep monitoring."}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "background-run-soak-test",
          finishReason: "stop",
        }),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
    };
    const supervisor = new BackgroundRunSupervisor({
      chatExecutor: {
        execute: vi
          .fn()
          .mockResolvedValueOnce(makeActorResult("Cycle 1.", 4))
          .mockResolvedValueOnce(makeActorResult("Cycle 2.", 4))
          .mockResolvedValueOnce(makeActorResult("Cycle 3.", 4)),
      } as any,
      supervisorLlm,
      getSystemPrompt: () => "background-run soak test",
      runStore: store,
      createToolHandler: (): ToolHandler => async () => "ok",
      publishUpdate: async () => undefined,
      now,
    });

    await supervisor.startRun({
      sessionId: "background-run-soak-multihour",
      objective: "Keep monitoring for multiple hours until the operator stops the run.",
    });
    await waitForSnapshot(
      supervisor,
      "background-run-soak-multihour",
      (snapshot) => snapshot.state === "working" && snapshot.lastUserUpdate === "Cycle 1 complete.",
    );

    currentTime += 2 * 60 * 60 * 1000;
    await supervisor.signalRun({
      sessionId: "background-run-soak-multihour",
      content: "Continue cycle 2.",
    });
    await waitForSnapshot(
      supervisor,
      "background-run-soak-multihour",
      (snapshot) => snapshot.state === "working" && snapshot.lastUserUpdate === "Cycle 2 complete.",
    );

    currentTime += 2 * 60 * 60 * 1000;
    await supervisor.signalRun({
      sessionId: "background-run-soak-multihour",
      content: "Continue cycle 3.",
    });
    await waitForSnapshot(
      supervisor,
      "background-run-soak-multihour",
      (snapshot) => snapshot.state === "working" && snapshot.lastUserUpdate === "Cycle 3 complete.",
    );

    currentTime += 2 * 60 * 60 * 1000;
    await supervisor.cancelRun(
      "background-run-soak-multihour",
      "Stopped the multi-hour soak test.",
    );

    const snapshot = await store.loadRecentSnapshot("background-run-soak-multihour");
    expect(snapshot?.state).toBe("cancelled");
    expect((snapshot?.updatedAt ?? 0) - (snapshot?.createdAt ?? 0)).toBeGreaterThanOrEqual(
      6 * 60 * 60 * 1000,
    );
  });
});
