/**
 * Phase 9 pipeline-quality benchmark runner.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { GatewayMessage } from "../gateway/message.js";
import {
  ChatExecutor,
  type ChatExecutorConfig,
} from "../llm/chat-executor.js";
import { LLMMessageValidationError } from "../llm/errors.js";
import {
  validateToolTurnSequence,
  type LLMMessage,
  type LLMProvider,
  type LLMChatOptions,
  type LLMResponse,
  type StreamProgressCallback,
} from "../llm/index.js";
import { parseTrajectoryTrace } from "./types.js";
import { TrajectoryReplayEngine } from "./replay.js";
import { runPipelineHttpRepro } from "./pipeline-http-repro.js";
import {
  buildPipelineQualityArtifact,
  type PipelineDesktopRunArtifact,
  type PipelineOfflineReplayFixtureArtifact,
  type PipelineQualityArtifact,
} from "./pipeline-quality.js";

const DEFAULT_CONTEXT_BENCHMARK_TURNS = 24;
const DEFAULT_DESKTOP_RUNS = 1;
const DEFAULT_DESKTOP_TIMEOUT_MS = 75_000;

export interface PipelineDesktopRunnerInput {
  runIndex: number;
  timeoutMs: number;
}

export type PipelineDesktopRunner = (
  input: PipelineDesktopRunnerInput,
) => Promise<PipelineDesktopRunArtifact>;

export interface PipelineQualityRunnerConfig {
  now?: () => number;
  runId?: string;
  turns?: number;
  desktopRuns?: number;
  desktopTimeoutMs?: number;
  incidentFixtureDir?: string;
  desktopRunner?: PipelineDesktopRunner;
}

interface ContextAndTokenBenchmarkResult {
  promptTokenSeries: number[];
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

interface ToolTurnBenchmarkResult {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

function createBenchmarkMessage(
  content: string,
  sessionId: string,
  turn: number,
): GatewayMessage {
  return {
    id: `phase9-msg-${turn}`,
    channel: "eval",
    senderId: "phase9-user",
    senderName: "Phase9",
    sessionId,
    content,
    timestamp: 1_700_000_000_000 + turn,
    scope: "dm",
  };
}

function estimateMessageChars(message: LLMMessage): number {
  const base = 48;
  if (typeof message.content === "string") {
    return base + message.content.length;
  }
  return (
    base +
    message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + part.image_url.url.length;
    }, 0)
  );
}

function estimatePromptTokens(messages: readonly LLMMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function createDeterministicBenchmarkProvider(): LLMProvider {
  const chat = async (messages: LLMMessage[], _options?: LLMChatOptions) => {
    const promptTokens = estimatePromptTokens(messages);
    const completionTokens = 24;
    const response: LLMResponse = {
      content: "ack",
      toolCalls: [],
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      model: "phase9-benchmark-model",
      finishReason: "stop",
    };
    return response;
  };

  return {
    name: "phase9-benchmark",
    chat,
    chatStream: async (
      messages: LLMMessage[],
      onChunk: StreamProgressCallback,
      options?: LLMChatOptions,
    ) => {
      const response = await chat(messages, options);
      onChunk({ content: response.content, done: true });
      return response;
    },
    healthCheck: async () => true,
  };
}

async function runContextAndTokenBenchmark(
  turns: number,
): Promise<ContextAndTokenBenchmarkResult> {
  const provider = createDeterministicBenchmarkProvider();
  const config: ChatExecutorConfig = {
    providers: [provider],
    plannerEnabled: false,
    maxModelRecallsPerRequest: 1,
    promptBudget: {
      contextWindowTokens: 2048,
      maxOutputTokens: 384,
      safetyMarginTokens: 384,
      hardMaxPromptChars: 3_200,
    },
    requestTimeoutMs: 20_000,
  };
  const executor = new ChatExecutor(config);

  const sessionId = "phase9-context-benchmark";
  const systemPrompt = [
    "You are running a deterministic benchmark for prompt growth.",
    "Return concise acknowledgements only.",
  ].join(" ");

  let history: LLMMessage[] = [];
  const promptTokenSeries: number[] = [];
  let completedTasks = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let turn = 0; turn < turns; turn++) {
    const content = `Phase 9 context turn ${turn}: ${"x".repeat(720)}`;
    const result = await executor.execute({
      message: createBenchmarkMessage(content, sessionId, turn),
      history,
      systemPrompt,
      sessionId,
      maxToolRounds: 1,
    });

    const promptTokens = result.callUsage.reduce(
      (sum, call) => sum + call.usage.promptTokens,
      0,
    );
    promptTokenSeries.push(promptTokens);

    totalPromptTokens += result.tokenUsage.promptTokens;
    totalCompletionTokens += result.tokenUsage.completionTokens;
    totalTokens += result.tokenUsage.totalTokens;
    if (result.stopReason === "completed") {
      completedTasks++;
    }

    history = [
      ...history,
      { role: "user", content },
      { role: "assistant", content: result.content },
    ];
  }

  return {
    promptTokenSeries,
    completedTasks,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
  };
}

function runToolTurnBenchmark(): ToolTurnBenchmarkResult {
  const validSequences: LLMMessage[][] = [
    [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "system.bash", arguments: '{"command":"echo"}' },
          { id: "call_b", name: "system.bash", arguments: '{"command":"pwd"}' },
        ],
      },
      { role: "tool", toolCallId: "call_b", content: '{"stdout":"x"}' },
      { role: "tool", toolCallId: "call_a", content: '{"stdout":"y"}' },
      { role: "assistant", content: "done" },
    ],
    [
      { role: "user", content: "once" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: '{"stdout":"ok"}' },
      { role: "assistant", content: "ok" },
    ],
  ];

  const malformedSequences: LLMMessage[][] = [
    [
      { role: "user", content: "bad" },
      { role: "assistant", content: "" },
      { role: "tool", toolCallId: "call_1", content: '{"stdout":""}' },
    ],
    [
      { role: "user", content: "bad" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "tool", toolCallId: "call_x", content: '{"stdout":"x"}' },
    ],
    [
      { role: "user", content: "bad" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "system.bash", arguments: '{"command":"ls"}' },
        ],
      },
      { role: "assistant", content: "missing tool result" },
    ],
  ];

  let validAccepted = 0;
  for (const sequence of validSequences) {
    validateToolTurnSequence(sequence);
    validAccepted++;
  }

  let malformedRejected = 0;
  let malformedForwarded = 0;
  for (const sequence of malformedSequences) {
    try {
      validateToolTurnSequence(sequence);
      malformedForwarded++;
    } catch (error) {
      if (error instanceof LLMMessageValidationError) {
        malformedRejected++;
        continue;
      }
      throw error;
    }
  }

  return {
    validCases: validSequences.length,
    validAccepted,
    malformedCases: malformedSequences.length,
    malformedRejected,
    malformedForwarded,
  };
}

function resolveDefaultIncidentFixtureDir(): string {
  const local = path.resolve(process.cwd(), "benchmarks/v1/incidents");
  if (existsSync(local)) return local;
  return path.resolve(process.cwd(), "runtime/benchmarks/v1/incidents");
}

async function runOfflineReplayBenchmark(
  fixtureDir: string,
): Promise<PipelineOfflineReplayFixtureArtifact[]> {
  const fixtures: PipelineOfflineReplayFixtureArtifact[] = [];
  const entries = await readdir(fixtureDir, { withFileTypes: true });
  const traceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".trace.json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const traceFile of traceFiles) {
    const fixtureId = traceFile.replace(/\.trace\.json$/, "");
    const fixturePath = path.join(fixtureDir, traceFile);

    let parsed: unknown;
    try {
      const raw = await readFile(fixturePath, "utf8");
      parsed = parseTrajectoryTrace(JSON.parse(raw) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fixtures.push({
        fixtureId,
        ok: false,
        parseError: message,
      });
      continue;
    }

    const replayEngine = new TrajectoryReplayEngine({ strictMode: true });
    const first = replayEngine.replay(parsed);
    const second = replayEngine.replay(parsed);
    const deterministicMismatch =
      first.deterministicHash !== second.deterministicHash;

    if (first.errors.length > 0) {
      fixtures.push({
        fixtureId,
        ok: false,
        replayError: first.errors.join("; "),
        deterministicMismatch,
      });
      continue;
    }

    fixtures.push({
      fixtureId,
      ok: !deterministicMismatch,
      deterministicMismatch,
    });
  }

  return fixtures;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("timeout"));
        }, timeoutMs);
      }),
    ]);
    return { timedOut: false, value };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return { timedOut: true };
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const defaultDesktopRunner: PipelineDesktopRunner = async ({
  runIndex,
  timeoutMs,
}) => {
  const runId = `desktop-${runIndex + 1}`;
  const started = Date.now();
  const result = await withTimeout(runPipelineHttpRepro(), timeoutMs);

  if (result.timedOut || !result.value) {
    return {
      runId,
      ok: false,
      timedOut: true,
      durationMs: Date.now() - started,
      preview: `timeout after ${timeoutMs}ms`,
    };
  }

  const output = result.value;
  const failedStep = output.steps.find((step) => !step.ok)?.step;
  const failedPreview = output.steps.find((step) => step.step === failedStep)
    ?.preview;
  return {
    runId,
    ok: output.overall === "pass",
    timedOut: false,
    durationMs: output.durationMs,
    failedStep,
    preview: failedPreview ?? "ok",
  };
};

/**
 * Run full Phase 9 pipeline-quality benchmark suite.
 */
export async function runPipelineQualitySuite(
  config: PipelineQualityRunnerConfig = {},
): Promise<PipelineQualityArtifact> {
  const now = config.now ?? Date.now;
  const turns = Math.max(2, Math.floor(config.turns ?? DEFAULT_CONTEXT_BENCHMARK_TURNS));
  const desktopRuns = Math.max(
    0,
    Math.floor(config.desktopRuns ?? DEFAULT_DESKTOP_RUNS),
  );
  const desktopTimeoutMs = Math.max(
    5_000,
    Math.floor(config.desktopTimeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS),
  );
  const runId = config.runId ?? `pipeline-quality-${now()}`;
  const desktopRunner = config.desktopRunner ?? defaultDesktopRunner;

  const contextAndToken = await runContextAndTokenBenchmark(turns);
  const toolTurn = runToolTurnBenchmark();

  const runSummaries: PipelineDesktopRunArtifact[] = [];
  for (let runIndex = 0; runIndex < desktopRuns; runIndex++) {
    runSummaries.push(await desktopRunner({ runIndex, timeoutMs: desktopTimeoutMs }));
  }

  const incidentFixtureDir =
    config.incidentFixtureDir ?? resolveDefaultIncidentFixtureDir();
  const replayFixtures = await runOfflineReplayBenchmark(incidentFixtureDir);

  return buildPipelineQualityArtifact({
    runId,
    generatedAtMs: now(),
    contextGrowth: {
      promptTokenSeries: contextAndToken.promptTokenSeries,
    },
    toolTurn,
    desktopStability: {
      runSummaries,
    },
    tokenEfficiency: {
      completedTasks: contextAndToken.completedTasks,
      totalPromptTokens: contextAndToken.totalPromptTokens,
      totalCompletionTokens: contextAndToken.totalCompletionTokens,
      totalTokens: contextAndToken.totalTokens,
    },
    offlineReplay: {
      fixtures: replayFixtures,
    },
  });
}
