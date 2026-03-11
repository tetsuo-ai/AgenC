import { describe, it, expect, vi } from "vitest";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor.js";
import { InMemoryDelegationTrajectorySink } from "../llm/delegation-learning.js";
import { derivePromptBudgetPlan } from "../llm/prompt-budget.js";
import type { Pipeline, PipelineResult } from "../workflow/pipeline.js";
import type { SubAgentConfig, SubAgentResult } from "./sub-agent.js";
import { SubAgentOrchestrator } from "./subagent-orchestrator.js";

class FakeSubAgentManager {
  private seq = 0;
  private readonly entries = new Map<string, {
    readyAt: number;
    result: SubAgentResult;
    delivered: boolean;
  }>();
  public activeCount = 0;
  public maxActiveCount = 0;
  public readonly spawnCalls: SubAgentConfig[] = [];

  constructor(
    private readonly delayMs: number,
    private readonly shouldSucceed = true,
  ) {}

  async spawn(config: SubAgentConfig): Promise<string> {
    const id = `sub-${++this.seq}`;
    this.spawnCalls.push(config);
    this.activeCount++;
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount);
    const primaryTool = config.tools?.[0];
    const successToolCall = this.shouldSucceed && primaryTool
      ? (() => {
        if (primaryTool === "mcp.browser.browser_navigate") {
          return {
            name: primaryTool,
            args: { url: "https://example.com/reference" },
            result: '{"ok":true,"url":"https://example.com/reference"}',
            isError: false,
            durationMs: 1,
          } as any;
        }
        if (primaryTool === "mcp.browser.browser_snapshot") {
          return {
            name: primaryTool,
            args: {},
            result: "Official documentation snapshot from https://example.com/reference",
            isError: false,
            durationMs: 1,
          } as any;
        }
        if (primaryTool === "desktop.text_editor") {
          return {
            name: primaryTool,
            args: {
              command: "create",
              path: "/workspace/src/game.js",
            },
            result: '{"ok":true}',
            isError: false,
            durationMs: 1,
          } as any;
        }
        if (
          primaryTool === "system.writeFile" ||
          primaryTool === "system.appendFile" ||
          primaryTool === "mcp.neovim.vim_buffer_save" ||
          primaryTool === "mcp.neovim.vim_search_replace"
        ) {
          return {
            name: primaryTool,
            args: {
              path: "/workspace/src/game.js",
              content: "export const ok = true;\n",
            },
            result: '{"path":"/workspace/src/game.js","bytesWritten":24}',
            isError: false,
            durationMs: 1,
          } as any;
        }
        return {
          name: primaryTool,
          args: {
            command: "printf",
            args: ["implemented /workspace/src/game.js"],
          },
          result: '{"stdout":"implemented /workspace/src/game.js","exitCode":0}',
          isError: false,
          durationMs: 1,
        } as any;
      })()
      : undefined;
    const evidenceLines = config.delegationSpec?.acceptanceCriteria?.length
      ? config.delegationSpec.acceptanceCriteria
      : [`Evidence collected for task ${id}.`];
    this.entries.set(id, {
      readyAt: Date.now() + this.delayMs,
      delivered: false,
      result: {
        sessionId: id,
        output: this.shouldSucceed
          ? `${evidenceLines.join("\n")}\n${config.delegationSpec?.objective ?? config.delegationSpec?.task ?? id}`
          : `failed:${id}`,
        success: this.shouldSucceed,
        durationMs: this.delayMs,
        toolCalls: successToolCall ? [successToolCall] : [],
      },
    });
    return id;
  }

  getResult(sessionId: string): SubAgentResult | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (Date.now() < entry.readyAt) return null;
    if (!entry.delivered) {
      entry.delivered = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
    return entry.result;
  }
}

interface SequencedOutcome {
  readonly delayMs: number;
  readonly result: Omit<SubAgentResult, "sessionId">;
}

class SequencedSubAgentManager {
  private seq = 0;
  private readonly entries = new Map<string, {
    readyAt: number;
    result: SubAgentResult;
    delivered: boolean;
  }>();
  public readonly spawnCalls: SubAgentConfig[] = [];

  constructor(private readonly outcomes: readonly SequencedOutcome[]) {}

  async spawn(config: SubAgentConfig): Promise<string> {
    const id = `seq-${++this.seq}`;
    const index = Math.min(this.seq - 1, this.outcomes.length - 1);
    const template = this.outcomes[index];
    if (!template) {
      throw new Error("No sequenced sub-agent outcomes configured");
    }
    this.spawnCalls.push(config);
    this.entries.set(id, {
      readyAt: Date.now() + template.delayMs,
      delivered: false,
      result: {
        ...template.result,
        sessionId: id,
      },
    });
    return id;
  }

  getResult(sessionId: string): SubAgentResult | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (Date.now() < entry.readyAt) return null;
    if (entry.delivered) return entry.result;
    entry.delivered = true;
    return entry.result;
  }
}

function createFallbackExecutor(
  impl: (pipeline: Pipeline) => Promise<PipelineResult>,
): DeterministicPipelineExecutor {
  return {
    execute: vi.fn((pipeline: Pipeline) => impl(pipeline)),
  };
}

describe("SubAgentOrchestrator", () => {
  it("falls back to base executor when planner steps are absent", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(10);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
    });

    const pipeline: Pipeline = {
      id: "p1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [{ name: "s1", tool: "system.health", args: {} }],
    };
    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(fallback.execute).toHaveBeenCalledTimes(1);
    expect(manager.spawnCalls).toHaveLength(0);
  });

  it("executes planner DAG nodes and collects subagent + deterministic results", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => {
      const step = pipeline.steps[0]!;
      return {
        status: "completed",
        context: {
          results: {
            ...pipeline.context.results,
            [step.name]: JSON.stringify({ stdout: "ok", step: step.name }),
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      };
    });
    const manager = new FakeSubAgentManager(30, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      allowParallelSubtasks: true,
      maxParallelSubtasks: 2,
      pollIntervalMs: 25,
    });

    const pipeline: Pipeline = {
      id: "planner:session-1:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_a",
          stepType: "subagent_task",
          objective: "Inspect module A",
          inputContract: "Return findings",
          acceptanceCriteria: ["evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["module_a"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "run_tool",
          stepType: "deterministic_tool",
          tool: "system.health",
          args: { verbose: true },
          dependsOn: ["delegate_a"],
        },
      ],
      edges: [{ from: "delegate_a", to: "run_tool" }],
      maxParallelism: 2,
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(2);
    expect(result.totalSteps).toBe(2);
    expect(result.context.results.delegate_a).toContain("Inspect module A");
    expect(result.context.results.run_tool).toContain('"step":"run_tool"');
    expect(fallback.execute).toHaveBeenCalledTimes(1);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.parentSessionId).toBe("session-1");
    expect(manager.spawnCalls[0]?.requiredCapabilities).toEqual([
      "system.readFile",
    ]);
  });

  it("passes working-directory context requirements through planner-emitted subagent spawns", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(10, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
    });

    const pipeline: Pipeline = {
      id: "planner:session-1:cwd",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement the grid router core",
          inputContract: "Return a short summary",
          acceptanceCriteria: ["write the core TypeScript files"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: [
            "repo_context",
            "working_directory:/home/tetsuo/agent-test/grid-router-ts",
          ],
          maxBudgetHint: "1m",
          canRunParallel: false,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.workingDirectory).toBe(
      "/home/tetsuo/agent-test/grid-router-ts",
    );
    expect(manager.spawnCalls[0]?.delegationSpec?.contextRequirements).toEqual([
      "repo_context",
      "working_directory:/home/tetsuo/agent-test/grid-router-ts",
    ]);
  });

  it("clamps planner-emitted child budget hints to the shared delegation minimum", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(10, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
    });

    await orchestrator.execute({
      id: "planner:session-min-budget:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement the parser",
          inputContract: "Project scaffold exists",
          acceptanceCriteria: ["Parser implementation written"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "0.08",
          canRunParallel: false,
        },
      ],
      edges: [],
    });

    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.timeoutMs).toBe(60_000);
  });

  it("emits normalized child trajectory records when trajectory sink is configured", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(10, true);
    const sink = new InMemoryDelegationTrajectorySink({ maxRecords: 10 });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveTrajectorySink: () => sink,
      pollIntervalMs: 5,
    });

    const pipeline: Pipeline = {
      id: "planner:session-trajectories:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate",
          stepType: "subagent_task",
          objective: "Inspect runtime source files",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const records = sink.snapshot();
    expect(records.length).toBeGreaterThan(0);
    const child = records.find((record) => record.turnType === "child");
    expect(child).toBeDefined();
    expect(child?.action.delegated).toBe(true);
    expect(child?.action.selectedTools).toContain("system.readFile");
    expect(child?.finalReward.value).toBeGreaterThan(0);
  });

  it("supports bounded parallel subagent execution", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(60, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      allowParallelSubtasks: true,
      maxParallelSubtasks: 3,
      pollIntervalMs: 25,
    });

    const pipeline: Pipeline = {
      id: "planner:session-par:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "a",
          stepType: "subagent_task",
          objective: "A",
          inputContract: "A",
          acceptanceCriteria: ["A"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["A"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "b",
          stepType: "subagent_task",
          objective: "B",
          inputContract: "B",
          acceptanceCriteria: ["B"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["B"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "c",
          stepType: "subagent_task",
          objective: "C",
          inputContract: "C",
          acceptanceCriteria: ["C"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["C"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
      ],
      maxParallelism: 3,
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(3);
    expect(manager.maxActiveCount).toBeGreaterThan(1);
  });

  it("supports serial execution when parallel subtasks are disabled", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(40, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      allowParallelSubtasks: false,
      maxParallelSubtasks: 8,
      pollIntervalMs: 25,
    });

    const pipeline: Pipeline = {
      id: "planner:session-ser:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "a",
          stepType: "subagent_task",
          objective: "A",
          inputContract: "A",
          acceptanceCriteria: ["A"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["A"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "b",
          stepType: "subagent_task",
          objective: "B",
          inputContract: "B",
          acceptanceCriteria: ["B"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["B"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
      ],
      maxParallelism: 8,
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(2);
    expect(manager.maxActiveCount).toBe(1);
  });

  it("fails fast when planner fanout exceeds hard cap", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxFanoutPerTurn: 1,
      pollIntervalMs: 10,
    });

    const result = await orchestrator.execute({
      id: "planner:session-fanout-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_a",
          stepType: "subagent_task",
          objective: "A",
          inputContract: "A",
          acceptanceCriteria: ["A"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["A"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "delegate_b",
          stepType: "subagent_task",
          objective: "B",
          inputContract: "B",
          acceptanceCriteria: ["B"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["B"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(result.error).toContain("maxFanoutPerTurn is 1");
    expect(manager.spawnCalls).toHaveLength(0);
  });

  it("allows long top-level planner dependency chains because recursive depth is enforced when children spawn", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxDepth: 1,
      pollIntervalMs: 10,
    });

    const result = await orchestrator.execute({
      id: "planner:session-depth-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_root",
          stepType: "subagent_task",
          objective: "root",
          inputContract: "root",
          acceptanceCriteria: ["root"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["root"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
        {
          name: "delegate_leaf",
          stepType: "subagent_task",
          objective: "leaf",
          inputContract: "leaf",
          acceptanceCriteria: ["leaf"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["leaf"],
          maxBudgetHint: "1m",
          canRunParallel: true,
          dependsOn: ["delegate_root"],
        },
      ],
      edges: [{ from: "delegate_root", to: "delegate_leaf" }],
    });

    expect(result.status).toBe("completed");
    expect(result.stopReasonHint).toBeUndefined();
    expect(manager.spawnCalls).toHaveLength(2);
  });

  it("opens circuit breaker when max spawned children per request is exceeded", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Provider error: fetch failed",
          success: false,
          durationMs: 20,
          toolCalls: [],
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Recovered",
          success: true,
          durationMs: 10,
          toolCalls: [],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxTotalSubagentsPerRequest: 1,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-spawn-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_retry",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("budget_exceeded");
    expect(result.error).toContain("max spawned children per request exceeded");
    expect(manager.spawnCalls).toHaveLength(1);
  });

  it("opens circuit breaker when cumulative child tool-call budget is exceeded", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Included findings from log analysis",
          success: true,
          durationMs: 10,
          toolCalls: [
            {
              name: "system.readFile",
              args: { path: "a" },
              result: "ok",
              isError: false,
              durationMs: 1,
            },
            {
              name: "system.readFile",
              args: { path: "b" },
              result: "ok",
              isError: false,
              durationMs: 1,
            },
            {
              name: "system.readFile",
              args: { path: "c" },
              result: "ok",
              isError: false,
              durationMs: 1,
            },
          ],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxCumulativeToolCallsPerRequestTree: 2,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-tool-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_tool_cap",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("budget_exceeded");
    expect(result.error).toContain("max cumulative child tool calls");
  });

  it("opens circuit breaker when cumulative child token budget is exceeded", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Included findings from log analysis",
          success: true,
          durationMs: 10,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 80,
            completionTokens: 50,
            totalTokens: 130,
          },
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxCumulativeTokensPerRequestTree: 100,
      maxCumulativeTokensPerRequestTreeExplicitlyConfigured: true,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-token-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_token_cap",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("budget_exceeded");
    expect(result.error).toContain("max cumulative child tokens");
  });

  it("scales the effective child-token budget with planned subagent count when using the default ceiling", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Included findings from log analysis",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/a.log" },
            result: '{"stdout":"finding a","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Included findings from runtime source analysis",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/b.log" },
            result: '{"stdout":"finding b","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxCumulativeTokensPerRequestTree: 250_000,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-token-floor:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_scope",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "delegate_map",
          stepType: "subagent_task",
          objective: "Map findings to source hotspots",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["delegate_scope"],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(2);
  });

  it("reserves default child-token headroom for one repair attempt per planned subagent step", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Included findings from log analysis",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/a.log" },
            result: '{"stdout":"finding a","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Mapped findings to source hotspots",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/b.log" },
            result: '{"stdout":"finding b","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Sub-agent timed out after 120000ms",
          success: false,
          durationMs: 120_000,
          toolCalls: [],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Included findings from demos/tests repair after retry",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/c.log" },
            result: '{"stdout":"finding c","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxCumulativeTokensPerRequestTree: 250_000,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-token-repair-headroom:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_scope",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "delegate_map",
          stepType: "subagent_task",
          objective: "Map findings to source hotspots",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["delegate_scope"],
        },
        {
          name: "delegate_repair",
          stepType: "subagent_task",
          objective: "Create demos and tests",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["workspace_files"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["delegate_map"],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(3);
    expect(manager.spawnCalls).toHaveLength(4);
  });

  it("honors an explicitly configured child-token ceiling as a hard limit", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Included findings from log analysis",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/a.log" },
            result: '{"stdout":"finding a","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Included findings from runtime source analysis",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/b.log" },
            result: '{"stdout":"finding b","exitCode":0}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 140_000,
            completionTokens: 10_000,
            totalTokens: 150_000,
          },
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      maxCumulativeTokensPerRequestTree: 250_000,
      maxCumulativeTokensPerRequestTreeExplicitlyConfigured: true,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-token-hard-cap:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_scope",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "delegate_map",
          stepType: "subagent_task",
          objective: "Map findings to source hotspots",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["delegate_scope"],
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("budget_exceeded");
    expect(result.error).toContain("max cumulative child tokens");
  });

  it("returns failed pipeline result when a subagent task fails", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(30, false);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 25,
    });

    const pipeline: Pipeline = {
      id: "planner:session-fail:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate",
          stepType: "subagent_task",
          objective: "A",
          inputContract: "A",
          acceptanceCriteria: ["A"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["A"],
          maxBudgetHint: "1m",
          canRunParallel: true,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Sub-agent step \"delegate\" failed");
  });

  it("preserves halted semantics from deterministic step execution", async () => {
    const fallback = createFallbackExecutor(async () => ({
      status: "halted",
      context: { results: {} },
      completedSteps: 0,
      totalSteps: 1,
      resumeFrom: 0,
    }));
    const manager = new FakeSubAgentManager(10, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
    });

    const pipeline: Pipeline = {
      id: "planner:session-halt:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "run_tool",
          stepType: "deterministic_tool",
          tool: "system.health",
          args: {},
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("halted");
    expect(result.resumeFrom).toBe(0);
  });

  it("curates child context with targeted history, required memory, and relevant tool outputs", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
    });

    const pipeline: Pipeline = {
      id: "planner:session-curation:123",
      createdAt: Date.now(),
      context: {
        results: {
          collect_logs: '{"status":"completed","summary":"CI failure cluster alpha"}',
        },
      },
      steps: [],
      plannerSteps: [
        {
          name: "collect_logs",
          stepType: "deterministic_tool",
          tool: "system.readFile",
          args: { path: "build.log" },
        },
        {
          name: "delegate_analysis",
          stepType: "subagent_task",
          objective: "Analyze CI failure clusters and propose remediation",
          inputContract: "Return clustered findings with evidence",
          acceptanceCriteria: ["At least 2 clusters"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs", "memory_semantic"],
          maxBudgetHint: "2m",
          canRunParallel: true,
          dependsOn: ["collect_logs"],
        },
      ],
      edges: [{ from: "collect_logs", to: "delegate_analysis" }],
      plannerContext: {
        parentRequest: "Diagnose CI pipeline failures from latest run.",
        history: [
          {
            role: "user",
            content: "Please cluster CI failures by error signature.",
          },
          {
            role: "assistant",
            content: "I will analyze build logs and failing tests.",
          },
          {
            role: "user",
            content: "Completely unrelated note about vacation photos.",
          },
        ],
        memory: [
          {
            source: "memory_semantic",
            content: "CI logs often fail in integration tests on branch main.",
          },
          {
            source: "memory_episodic",
            content: "Yesterday we discussed UI color palettes.",
          },
        ],
        toolOutputs: [
          {
            toolName: "system.readFile",
            content: "build.log: cluster alpha indicates flaky integration tests",
          },
          {
            toolName: "system.httpGet",
            content: "sports API response from unrelated endpoint",
          },
        ],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain("Curated parent history slice");
    expect(prompt).toContain("cluster CI failures");
    expect(prompt).not.toContain("vacation photos");
    expect(prompt).toContain("[memory_semantic]");
    expect(prompt).not.toContain("UI color palettes");
    expect(prompt).toContain("[dependency:collect_logs]");
    expect(prompt).toContain("[tool:system.readFile]");
    expect(prompt).not.toContain("sports API response");
    expect(prompt).toContain("Context curation diagnostics");
  });

  it("redacts sensitive artifacts before child prompt assembly", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
    });

    const pipeline: Pipeline = {
      id: "planner:session-redaction:123",
      createdAt: Date.now(),
      context: {
        results: {
          collect_logs:
            '{"token":"Bearer abc.def.ghi","url":"http://localhost:3000/admin"}',
        },
      },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_redact",
          stepType: "subagent_task",
          objective: "Analyze outputs with api_key=super-secret-value",
          inputContract: "Return findings summary",
          acceptanceCriteria: ["Do not leak secrets"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["memory_semantic"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest:
          "Please inspect file:///home/tetsuo/private/key.pem and http://127.0.0.1:8080",
        history: [
          {
            role: "user",
            content:
              "Token: Bearer supersecrettoken and key sk-abcdefghijklmnopqrstuvwxyz",
          },
        ],
        memory: [
          {
            source: "memory_semantic",
            content:
              "Absolute path /home/tetsuo/.ssh/id_rsa and data:image/png;base64,AAAA",
          },
          {
            source: "memory_episodic",
            content: "This episodic memory should not leak by default",
          },
        ],
        toolOutputs: [
          {
            toolName: "system.readFile",
            content: "Fetched from http://192.168.1.20:8080/private",
          },
        ],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain("[REDACTED_TOKEN]");
    expect(prompt).toContain("[REDACTED_API_KEY]");
    expect(prompt).toContain("[REDACTED_INTERNAL_URL]");
    expect(prompt).toContain("[REDACTED_FILE_URL]");
    expect(prompt).toContain("[REDACTED_ABSOLUTE_PATH]");
    expect(prompt).toContain("[REDACTED_IMAGE_DATA_URL]");
    expect(prompt).not.toContain("supersecrettoken");
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(prompt).not.toContain("127.0.0.1:8080");
    expect(prompt).not.toContain("192.168.1.20:8080");
    expect(prompt).not.toContain("/home/tetsuo/.ssh/id_rsa");
    expect(prompt).not.toContain("episodic memory should not leak");
  });

  it("emits truncation diagnostics when curated context exceeds section caps", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
    });

    const veryLong = "x".repeat(1_600);
    const pipeline: Pipeline = {
      id: "planner:session-caps:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_caps",
          stepType: "subagent_task",
          objective: "Review CI logs and summarize failures",
          inputContract: "Return concise failure groups",
          acceptanceCriteria: ["Concise summary"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs", "memory_semantic"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest: "Analyze CI build failures from large logs.",
        history: Array.from({ length: 20 }, (_, index) => ({
          role: (index % 2 === 0 ? "user" : "assistant") as
            | "user"
            | "assistant",
          content: `history-${index}-ci ${veryLong}`,
        })),
        memory: Array.from({ length: 6 }, (_, index) => ({
          source: "memory_semantic" as const,
          content: `semantic-${index} ${veryLong}`,
        })),
        toolOutputs: Array.from({ length: 10 }, (_, index) => ({
          toolName: "system.readFile",
          content: `tool-${index} ${veryLong}`,
        })),
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain("Context curation diagnostics");
    expect(prompt).toContain('"history":{"selected":');
    expect(prompt).toContain('"available":20');
    expect(prompt).toContain('"truncated":true');
  });

  it("derives child tools from parent policy intersection and required capabilities", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
      childToolAllowlistStrategy: "inherit_intersection",
      allowedParentTools: ["system.readFile", "system.listFiles", "system.bash"],
      forbiddenParentTools: ["system.bash"],
      resolveAvailableToolNames: () => [
        "system.readFile",
        "system.bash",
        "system.listFiles",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-toolscope:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_scope",
          stepType: "subagent_task",
          objective: "Analyze failure clusters",
          inputContract: "Return summary",
          acceptanceCriteria: ["summary"],
          requiredToolCapabilities: [
            "system.readFile",
            "system.bash",
            "system.httpGet",
          ],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest: "Analyze CI failures",
        history: [],
        memory: [],
        toolOutputs: [],
        parentAllowedTools: ["system.readFile", "system.bash"],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual(["system.readFile"]);
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain('"removedByPolicy":["system.bash","system.httpGet"]');
  });

  it("rejects overloaded subagent steps before spawning a child", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
    });

    const pipeline: Pipeline = {
      id: "planner:session-overloaded:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_overloaded",
          stepType: "subagent_task",
          objective:
            "Scaffold project, install dependencies, create index.html, package.json, tsconfig.json, src/main.ts, src/Game.ts, " +
            "verify localhost, validate console errors, and document how to play.",
          inputContract:
            "Return JSON with files, run_cmd, validation steps, how to play, and known limitations",
          acceptanceCriteria: [
            "Create index.html",
            "Create package.json",
            "Create src/main.ts",
            "Create src/Game.ts",
            "Validate localhost runs cleanly",
          ],
          requiredToolCapabilities: ["desktop.bash"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest: "Build the game end to end",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("overloaded subagent step");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.context.results.delegate_overloaded).toContain(
      '"status":"needs_decomposition"',
    );
    expect(manager.spawnCalls).toHaveLength(0);
  });

  it("blocks delegation-tool capability expansion from child sessions", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
      childToolAllowlistStrategy: "explicit_only",
      resolveAvailableToolNames: () => [
        "system.readFile",
        "execute_with_agent",
        "agenc.subagent.spawn",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-no-expand:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_no_expand",
          stepType: "subagent_task",
          objective: "Investigate logs",
          inputContract: "Return summary",
          acceptanceCriteria: ["summary"],
          requiredToolCapabilities: [
            "execute_with_agent",
            "agenc.subagent.spawn",
            "system.readFile",
          ],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual(["system.readFile"]);
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain('"removedAsDelegationTools":["execute_with_agent","agenc.subagent.spawn"]');
  });

  it("sanitizes parent orchestration plans out of child prompts", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            "Heat Signature https://example.com/heat-signature\nGunpoint https://example.com/gunpoint\nMonaco https://example.com/monaco\nTuning targets: speed 220, mutation 30s.",
          success: true,
          durationMs: 5,
          toolCalls: [{
            name: "mcp.browser.browser_navigate",
            args: { url: "https://example.com/heat-signature" },
            result: '{"ok":true,"url":"https://example.com/heat-signature"}',
            isError: false,
            durationMs: 1,
          }],
          stopReason: "completed",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => [
        "desktop.bash",
        "mcp.browser.browser_snapshot",
        "mcp.browser.browser_navigate",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-parent-sanitize:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "design_research",
          stepType: "subagent_task",
          objective: "Research 3 reference games and extract tuning targets.",
          inputContract: "Return markdown with citations",
          acceptanceCriteria: ["List 3 references", "Include tuning targets"],
          requiredToolCapabilities: ["mcp.browser.browser_snapshot"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest:
          "Build Neon Heist. Sub-agent orchestration plan (required): 1) `design_research`: - Research references. 2) `tech_research`: - Compare frameworks. Final deliverables: runnable game.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const taskPrompt = manager.spawnCalls[0]?.task ?? "";
    expect(taskPrompt).toContain("Execute only the assigned phase `design_research`.");
    expect(taskPrompt).not.toContain("Sub-agent orchestration plan (required)");
    expect(taskPrompt).not.toContain("tech_research");
    expect(taskPrompt).toContain("Assigned phase only: design_research");
  });

  it("sanitizes compact required-orchestration prompts without parentheses or backticks", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(5, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => ["desktop.bash"],
    });

    const pipeline: Pipeline = {
      id: "planner:session-parent-sanitize-compact:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "recover_marker",
          stepType: "subagent_task",
          objective:
            "Recover the earlier continuity marker from parent conversation context only.",
          inputContract: "Return the marker only",
          acceptanceCriteria: ["Recover the exact prior marker from context only"],
          requiredToolCapabilities: ["context_retrieval"],
          contextRequirements: ["parent conversation history"],
          maxBudgetHint: "minimal",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest:
          "Sub-agent orchestration plan required: 1. recover_marker: recover marker from context only. 2. echo_marker: print it once. Final deliverables: recovered marker, printed output, known limitations.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const taskPrompt = manager.spawnCalls[0]?.task ?? "";
    expect(taskPrompt).not.toContain("Sub-agent orchestration plan required:");
    expect(taskPrompt).not.toContain("echo_marker");
    expect(taskPrompt).toContain("Assigned phase only: recover_marker");
  });

  it("adds structured shell usage guidance to child prompts when shell tools are allowed", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.writeFile",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-shell-guidance:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "setup_project",
          stepType: "subagent_task",
          objective: "Update package.json and scaffold source files.",
          inputContract: "cwd=/workspace/project",
          acceptanceCriteria: ["Files updated", "Project layout created"],
          requiredToolCapabilities: ["file_system_write", "shell_execution"],
          contextRequirements: ["cwd=/workspace/project"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest: "Scaffold the project in /workspace/project.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const step = pipeline.plannerSteps[0]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(step, pipeline, {}, toolScope);

    expect(taskPrompt).toContain(
      "For `system.bash`/`desktop.bash` direct mode, `command` must be exactly one executable token.",
    );
    expect(taskPrompt).toContain(
      "Use file-write tools for file contents instead of shell heredocs",
    );
    expect(taskPrompt).toContain(
      "Verification commands must be non-interactive and exit on their own.",
    );
  });

  it("uses budget-derived caps and structural dependency summaries in child prompts", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      childPromptBudget: {
        contextWindowTokens: 8_192,
        maxOutputTokens: 1_024,
        safetyMarginTokens: 1_024,
        charPerToken: 4,
        hardMaxPromptChars: 12_000,
      },
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.writeFile",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-budgeted-prompt:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "add_tests_readme",
          stepType: "subagent_task",
          objective: "Add tests and README for the project.",
          inputContract: "CLI and demos already exist.",
          acceptanceCriteria: ["Tests added", "README added"],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/workspace/project"],
          maxBudgetHint: "5m",
          canRunParallel: false,
          dependsOn: ["implement_cli_and_demos"],
        },
      ],
      plannerContext: {
        parentRequest: "Finish the project in /workspace/project.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const dependencyResult = JSON.stringify({
      status: "completed",
      success: true,
      durationMs: 32655,
      output: "CLI implemented, demos added, package bin verified.",
      tokenUsage: { totalTokens: 4321 },
      toolCalls: [
        {
          name: "system.writeFile",
          args: { path: "/workspace/project/src/cli.ts" },
          result: "{\"bytesWritten\":2121}",
        },
        {
          name: "system.bash",
          args: { command: "npx", args: ["tsc", "--noEmit"] },
          result: "{\"exitCode\":0}",
        },
      ],
    });

    const step = pipeline.plannerSteps[0]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(
      step,
      pipeline,
      { implement_cli_and_demos: dependencyResult },
      toolScope,
    );

    const plan = derivePromptBudgetPlan({
      contextWindowTokens: 8_192,
      maxOutputTokens: 1_024,
      safetyMarginTokens: 1_024,
      charPerToken: 4,
      hardMaxPromptChars: 12_000,
    });
    const maxPromptChars =
      plan.caps.userChars +
      plan.caps.historyChars +
      plan.caps.memoryChars +
      plan.caps.toolChars +
      plan.caps.assistantRuntimeChars +
      plan.caps.otherChars;

    expect(taskPrompt.length).toBeLessThanOrEqual(maxPromptChars);
    expect(taskPrompt).toContain("\"toolCallSummary\"");
    expect(taskPrompt).toContain("\"tokenUsage\":{\"totalTokens\":4321}");
    expect(taskPrompt).not.toContain("\"toolCalls\"");
  });

  it("injects dependency-derived file context into child prompts", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      childPromptBudget: {
        contextWindowTokens: 8_192,
        maxOutputTokens: 1_024,
        safetyMarginTokens: 1_024,
        charPerToken: 4,
        hardMaxPromptChars: 12_000,
      },
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.writeFile",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-artifact-context:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "demos_tests",
          stepType: "subagent_task",
          objective:
            "Add demo maps and comprehensive Vitest tests covering parser, portals, conveyors, and CLI behavior.",
          inputContract: "Core and CLI already implemented.",
          acceptanceCriteria: [
            "Demo maps present",
            "All tests pass with Vitest",
          ],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/project"],
          maxBudgetHint: "6m",
          canRunParallel: false,
          dependsOn: ["core_implementation", "cli_implementation"],
        },
      ],
      plannerContext: {
        parentRequest: "Finish the terrain router workspace in /workspace/project.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const coreResult = JSON.stringify({
      status: "completed",
      success: true,
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/src/index.ts",
            content:
              "export function findPath(map: string) { return { overlay: map, path: [], cost: 0, visited: [] }; }",
          },
        },
        {
          name: "system.bash",
          args: { command: "cat", args: ["packages/core/package.json"] },
          result:
            JSON.stringify({
              stdout:
                "{\n  \"name\": \"@terrain-router/core\",\n  \"main\": \"dist/index.js\"\n}",
            }),
        },
      ],
    });
    const cliResult = JSON.stringify({
      status: "completed",
      success: true,
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/cli/src/cli.ts",
            content:
              "import { findPath } from '@terrain-router/core';\nconsole.log(findPath('S.G'));",
          },
        },
      ],
    });

    const step = pipeline.plannerSteps[0]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(
      step,
      pipeline,
      {
        core_implementation: coreResult,
        cli_implementation: cliResult,
      },
      toolScope,
    );

    expect(taskPrompt).toContain("Dependency-derived workspace context:");
    expect(taskPrompt).toContain("[artifact:core_implementation:packages/core/src/index.ts]");
    expect(taskPrompt).toContain("[artifact:cli_implementation:packages/cli/src/cli.ts]");
    expect(taskPrompt).toContain("\"dependencyArtifacts\":{");
    expect(taskPrompt).toContain("\"available\":3");
  });

  it("injects host tooling constraints into npm workspace child prompts", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.writeFile",
      ],
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence:
            'Unsupported URL Type "workspace:": workspace:*',
        },
      }),
    });

    const pipeline: Pipeline = {
      id: "planner:session-host-tooling:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "init_monorepo",
          stepType: "subagent_task",
          objective:
            "Init npm workspace root with package.json, tsconfig, and package manifests for packages/core and packages/cli",
          inputContract:
            "Create package.json files and install TypeScript workspace dependencies",
          acceptanceCriteria: [
            "workspaces configured",
            "deps installed",
          ],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "2m",
        },
      ],
      edges: [],
    };

    const step = pipeline.plannerSteps[0]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(step, pipeline, {}, toolScope);

    expect(taskPrompt).toContain("Host tooling constraints:");
    expect(taskPrompt).toContain("workspace:*");
    expect(taskPrompt).toContain("\"hostTooling\":{");
    expect(taskPrompt).toContain("\"npmWorkspaceProtocolSupport\":\"unsupported\"");
  });

  it("uses transitive dependency artifacts to inject host tooling into downstream CLI phases", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.readFile",
        "system.writeFile",
      ],
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence:
            'Unsupported URL Type "workspace:": workspace:*',
        },
      }),
    });

    const pipeline: Pipeline = {
      id: "planner:session-cli-transitive-host-tooling:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "setup_project_structure",
          stepType: "subagent_task",
          objective:
            "Create npm workspace root plus package manifests for packages/core and packages/cli",
          inputContract: "Scaffold the package manifests and workspace config",
          acceptanceCriteria: [
            "package manifests exist",
          ],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "2m",
        },
        {
          name: "implement_core_logic",
          stepType: "subagent_task",
          objective: "Implement packages/core/src/index.ts findPath logic",
          inputContract: "Export findPath from packages/core/src/index.ts",
          acceptanceCriteria: ["findPath exported"],
          requiredToolCapabilities: ["system.writeFile", "system.readFile"],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "4m",
          dependsOn: ["setup_project_structure"],
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective:
            "In packages/cli implement a CLI that depends on @terrain-router/core and builds cleanly",
          inputContract: "CLI reads stdin or a file argument",
          acceptanceCriteria: [
            "Depends on @terrain-router/core",
            "Builds cleanly",
          ],
          requiredToolCapabilities: [
            "system.readFile",
            "system.writeFile",
            "system.bash",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "2m",
          dependsOn: ["implement_core_logic"],
        },
      ],
      edges: [],
      plannerContext: {
        parentRequest:
          "Build /workspace/terrain-router-ts as a new npm + TypeScript workspace with packages/core and packages/cli.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const setupResult = JSON.stringify({
      status: "completed",
      success: true,
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "package.json",
            content:
              '{ "private": true, "workspaces": ["packages/*"], "scripts": { "build": "tsc -b" } }',
          },
          result:
            '{"path":"package.json","bytesWritten":86}',
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/cli/package.json",
            content:
              '{ "name": "@terrain-router/cli", "dependencies": { "@terrain-router/core": "file:../core" } }',
          },
          result:
            '{"path":"packages/cli/package.json","bytesWritten":95}',
        },
      ],
    });
    const coreResult = JSON.stringify({
      status: "completed",
      success: true,
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/src/index.ts",
            content:
              "export function findPath(map: string, algorithm: 'dijkstra' | 'astar' = 'dijkstra') { return { map, algorithm }; }\n",
          },
          result:
            '{"path":"packages/core/src/index.ts","bytesWritten":118}',
        },
      ],
    });

    const step = pipeline.plannerSteps[2]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(
      step,
      pipeline,
      {
        setup_project_structure: setupResult,
        implement_core_logic: coreResult,
      },
      toolScope,
    );

    expect(taskPrompt).toContain("[dependency:setup_project_structure]");
    expect(taskPrompt).toContain("Host tooling constraints:");
    expect(taskPrompt).toContain("workspace:*");
    expect(taskPrompt).toContain(
      "[artifact:setup_project_structure:packages/cli/package.json]",
    );
    expect(taskPrompt).toContain(
      "[artifact:implement_core_logic:packages/core/src/index.ts]",
    );
  });

  it("surfaces downstream build and verification contracts in child prompts", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      pollIntervalMs: 5,
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-downstream-contracts:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement packages/core/src/index.ts terrain routing logic",
          inputContract: "Monorepo already scaffolded",
          acceptanceCriteria: ["findPath exported"],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "6m",
          canRunParallel: false,
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Build the CLI around the core package",
          inputContract: "Core package implemented and buildable",
          acceptanceCriteria: ["CLI compiles cleanly"],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "3m",
          canRunParallel: false,
          dependsOn: ["implement_core"],
        },
        {
          name: "run_test",
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["test", "--", "--run"],
            cwd: "/workspace/terrain-router-ts",
          },
          dependsOn: ["implement_cli"],
        },
        {
          name: "run_build",
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/workspace/terrain-router-ts",
          },
          dependsOn: ["run_test"],
        },
      ],
      plannerContext: {
        parentRequest:
          "Build /workspace/terrain-router-ts as a TypeScript workspace and verify it with npm test and npm run build.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const step = pipeline.plannerSteps[0]!;
    const toolScope = (orchestrator as unknown as {
      deriveChildToolAllowlist: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
      ) => {
        allowedTools: readonly string[];
        allowsToollessExecution: boolean;
        semanticFallback: readonly string[];
        removedLowSignalBrowserTools: readonly string[];
        removedByPolicy: readonly string[];
        removedAsDelegationTools: readonly string[];
        removedAsUnknownTools: readonly string[];
        parentPolicyAllowed: readonly string[];
      };
    }).deriveChildToolAllowlist(step, pipeline);
    const { taskPrompt } = (orchestrator as unknown as {
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: typeof toolScope,
      ) => { taskPrompt: string };
    }).buildSubagentTaskPrompt(step, pipeline, {}, toolScope);

    expect(taskPrompt).toContain("Downstream execution requirements:");
    expect(taskPrompt).toContain("`implement_cli` expects: Core package implemented and buildable");
    expect(taskPrompt).toContain(
      "Later deterministic verification reruns the workspace test command in non-interactive single-run mode.",
    );
    expect(taskPrompt).toContain("Later deterministic verification runs `npm run build`.");
  });

  it("adds semantic fallback tools for implementation steps when planner capabilities are unusable", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(5, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => [
        "desktop.bash",
        "mcp.browser.browser_snapshot",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_tabs",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-semantic-fallback:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "core_implementation",
          stepType: "subagent_task",
          objective:
            "Implement rendering and scoring for the core gameplay loop.",
          inputContract: "Return summary",
          acceptanceCriteria: ["Provide an implementation summary with evidence"],
          requiredToolCapabilities: ["COMPUTE" as unknown as string],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "8m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest: "Build the Neon Heist core gameplay.",
        history: [],
        memory: [],
        toolOutputs: [],
        parentAllowedTools: ["desktop.bash", "mcp.browser.browser_snapshot"],
      },
    };

    await orchestrator.execute(pipeline);

    expect(manager.spawnCalls.length).toBeGreaterThanOrEqual(1);
    expect(manager.spawnCalls[0]?.tools).toEqual(["desktop.bash"]);
    expect(manager.spawnCalls[0]?.task).toContain(
      '"semanticFallback":["desktop.bash"]',
    );
  });

  it("prunes low-signal browser tab tools from research child scope", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(5, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
        "mcp.browser.browser_tabs",
      ],
    });

    await orchestrator.execute({
      id: "planner:session-browser-scope:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "design_research",
          stepType: "subagent_task",
          objective:
            "Research 3 reference games with browser tools and cite sources.",
          inputContract: "Return markdown with citations and tuning targets",
          acceptanceCriteria: ["Include citations and tuning targets"],
          requiredToolCapabilities: [
            "mcp.browser.browser_navigate",
            "mcp.browser.browser_snapshot",
            "mcp.browser.browser_tabs",
          ],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest: "Research reference games.",
        history: [],
        memory: [],
        toolOutputs: [],
        parentAllowedTools: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
          "mcp.browser.browser_tabs",
        ],
      },
    });

    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual([
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
    ]);
    expect(manager.spawnCalls[0]?.task).toContain(
      '"removedLowSignalBrowserTools":["mcp.browser.browser_tabs"]',
    );
  });

  it("fails fast when parent policy leaves no permitted child tools", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
      childToolAllowlistStrategy: "inherit_intersection",
      allowedParentTools: ["system.listFiles"],
      resolveAvailableToolNames: () => ["system.readFile", "system.listFiles"],
    });

    const pipeline: Pipeline = {
      id: "planner:session-empty-scope:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_empty_scope",
          stepType: "subagent_task",
          objective: "Inspect logs",
          inputContract: "Return summary",
          acceptanceCriteria: ["summary"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("No permitted child tools remain");
    expect(manager.spawnCalls).toHaveLength(0);
  });

  it("allows context-only subagent steps to run without tools when policy scope resolves no explicit tools", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 10,
      childToolAllowlistStrategy: "inherit_intersection",
      allowedParentTools: ["desktop.bash", "desktop.text_editor"],
      resolveAvailableToolNames: () => ["desktop.bash", "desktop.text_editor"],
    });

    const pipeline: Pipeline = {
      id: "planner:session-context-only:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        history: [{
          role: "user",
          content:
            "Memory continuity M1. Memorize token OBSIDIAN-LATTICE-44 and checksum 7A91-KAPPA for a later exact recall.",
        }],
      },
      plannerSteps: [
        {
          name: "recover_marker",
          stepType: "subagent_task",
          objective:
            "Recover the earlier continuity marker from parent conversation context only; do not invent missing facts",
          inputContract: "Provided recent conversation context and partial response",
          acceptanceCriteria: [
            "Recover the exact prior marker from context only",
          ],
          requiredToolCapabilities: ["context_retrieval"],
          contextRequirements: ["parent_conversation_context"],
          maxBudgetHint: "minimal",
          canRunParallel: false,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual([]);
    expect(manager.spawnCalls[0]?.task).toContain(
      "Allowed tools (policy-scoped): none. Complete this phase from curated parent context, memory, and dependency outputs only.",
    );
    expect(manager.spawnCalls[0]?.task).toContain("OBSIDIAN-LATTICE-44");
  });

  it("fails fast when browser-grounded work is left with only low-signal tab inspection tools", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new FakeSubAgentManager(20, true);
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveLifecycleEmitter: () => ({
        emit: (event: Record<string, unknown>) => lifecycleEvents.push(event),
      } as any),
      pollIntervalMs: 10,
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => ["mcp.browser.browser_tabs"],
      allowedParentTools: ["mcp.browser.browser_tabs"],
    });

    const result = await orchestrator.execute({
      id: "planner:session-low-signal-browser-only:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "design_research",
          stepType: "subagent_task",
          objective:
            "Research 3 reference games with browser tools and cite sources.",
          inputContract: "Return markdown with citations and tuning targets",
          acceptanceCriteria: ["Include citations and tuning targets"],
          requiredToolCapabilities: [
            "mcp.browser.browser_tabs",
          ],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("low-signal browser state checks");
    expect(manager.spawnCalls).toHaveLength(0);
    const failedEvents = lifecycleEvents.filter(
      (event) => event.type === "subagents.failed",
    );
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.payload).toEqual(
      expect.objectContaining({
        stepName: "design_research",
        stage: "validation",
      }),
    );
    expect(
      (failedEvents[0]?.payload as { reason?: string } | undefined)?.reason,
    ).toContain("low-signal browser state checks");
  });

  it("retries timeout failures with deterministic backoff and then succeeds", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Sub-agent timed out after 120000ms",
          success: false,
          durationMs: 120_000,
          toolCalls: [],
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Recovered after retry with evidence and findings",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/ci.log" },
            result: '{"content":"evidence"}',
            isError: false,
            durationMs: 1,
          } as any],
        },
      },
    ]);
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveLifecycleEmitter: () => ({
        emit: (event: Record<string, unknown>) => lifecycleEvents.push(event),
      } as any),
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-timeout:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_timeout",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Findings include evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(2);
    const payload = JSON.parse(result.context.results.delegate_timeout ?? "{}") as {
      attempts?: number;
    };
    expect(payload.attempts).toBe(2);
    const failedEvents = lifecycleEvents.filter(
      (event) => event.type === "subagents.failed",
    );
    expect(failedEvents).toHaveLength(1);
    const failedPayload = failedEvents[0]?.payload as
      | { retrying?: boolean; nextRetryDelayMs?: number }
      | undefined;
    expect(failedPayload?.retrying).toBe(true);
    expect(failedPayload?.nextRetryDelayMs).toBe(75);
  });

  it("applies malformed result-contract retry semantics and maps validation stop reason", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "{}",
          success: true,
          durationMs: 12,
          toolCalls: [],
        },
      },
      {
        delayMs: 5,
        result: {
          output: "{}",
          success: true,
          durationMs: 11,
          toolCalls: [],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-contract:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_contract",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return JSON object",
          acceptanceCriteria: ["Return JSON object"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.toLowerCase()).toContain("malformed result contract");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(manager.spawnCalls).toHaveLength(2);
    expect(manager.spawnCalls[1]?.task).toContain("Retry corrections (attempt 1)");
    expect(manager.spawnCalls[1]?.task).toContain(
      "You must invoke one or more of the allowed tools before answering.",
    );
  });

  it("carries the last validation code into retried child spawns for routing-aware recovery", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            "**Phase `add_tests_demos` complete** Added demos and tests in `demos/basic.txt` and `packages/core/src/index.test.ts`.",
          success: true,
          durationMs: 14,
          toolCalls: [{
            name: "system.writeFile",
            args: {
              path: "packages/core/src/index.test.ts",
              content: "test('ok', () => expect(true).toBe(true));\n",
            },
            result:
              '{"path":"packages/core/src/index.test.ts","bytesWritten":42}',
            durationMs: 2,
          }],
        },
      },
      {
        delayMs: 5,
        result: {
          output:
            "Demo maps present at `demos/basic.txt` and `demos/conveyor.txt`.\n" +
            "All tests pass with Vitest via `vitest run`.\n" +
            "Coverage for required cases was added in `packages/core/src/index.test.ts`.",
          success: true,
          durationMs: 11,
          toolCalls: [
            {
              name: "system.writeFile",
              args: {
                path: "packages/core/src/index.test.ts",
                content: "test('ok', () => expect(true).toBe(true));\n",
              },
              result:
                '{"path":"packages/core/src/index.test.ts","bytesWritten":42}',
              durationMs: 2,
            },
            {
              name: "system.bash",
              args: {
                command: "vitest",
                args: ["run"],
              },
              result:
                '{"stdout":"PASS","stderr":"","exitCode":0}',
              durationMs: 3,
            },
          ],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-retry-validation-code:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "add_tests_demos",
          stepType: "subagent_task",
          objective:
            "Add demo maps and comprehensive Vitest tests covering parser, portals, conveyors, unreachable maps, and CLI behavior.",
          inputContract: "Core+CLI already implemented",
          acceptanceCriteria: [
            "Demo maps present",
            "All tests pass with Vitest",
            "Coverage for required cases",
          ],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "3m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toMatch(/^(completed|failed)$/);
    expect(manager.spawnCalls).toHaveLength(2);
    expect(manager.spawnCalls[1]?.delegationSpec?.lastValidationCode).toBe(
      "acceptance_evidence_missing",
    );
  });

  it("fails blocked successful child outputs without retrying them as completed phases", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            "**implement_cli blocked** Updated `./packages/cli/src/index.ts`, but the core package is not buildable yet and I cannot finish this phase until that issue is fixed.",
          success: true,
          durationMs: 14,
          toolCalls: [{
            name: "system.writeFile",
            args: {
              path: "packages/cli/src/index.ts",
              content: "export {};\n",
            },
            result:
              '{"path":"packages/cli/src/index.ts","bytesWritten":10}',
            durationMs: 3,
          }],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-blocked-phase-output:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Build the CLI package and keep the workspace buildable",
          inputContract: "Core package implemented and buildable",
          acceptanceCriteria: ["CLI reads input and outputs summary"],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "3m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("blocked or incomplete");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(manager.spawnCalls).toHaveLength(1);
  });

  it("blocks dependent DAG nodes when an upstream delegated step falls back unresolved", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => {
      const step = pipeline.steps[0]!;
      return {
        status: "completed",
        context: {
          results: {
            ...pipeline.context.results,
            [step.name]: JSON.stringify({ stdout: "verified" }),
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      };
    });
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Tool budget exceeded (24 per request)",
          success: false,
          durationMs: 12,
          toolCalls: [],
          stopReason: "budget_exceeded",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "continue_without_delegation",
    });

    const result = await orchestrator.execute({
      id: "planner:session-dependency-blocked:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [{ name: "verify_independent", tool: "system.bash", args: {} }],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement the core package",
          inputContract: "Workspace structure exists",
          acceptanceCriteria: ["Core builds"],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/maze-forge"],
          maxBudgetHint: "3m",
          canRunParallel: true,
        },
        {
          name: "verify_independent",
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: { command: "npm", args: ["run", "lint"] },
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Implement the CLI package",
          inputContract: "Core package fully implemented and buildable",
          acceptanceCriteria: ["CLI builds"],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/maze-forge"],
          maxBudgetHint: "3m",
          canRunParallel: true,
          dependsOn: ["implement_core"],
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.completedSteps).toBe(2);
    expect(result.error).toContain("implement_cli");
    expect(result.error).toContain("implement_core");
    expect(result.stopReasonHint).toBe("budget_exceeded");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(fallback.execute).toHaveBeenCalledTimes(1);

    const corePayload = JSON.parse(
      result.context.results.implement_core ?? "{}",
    ) as {
      status?: string;
      stopReasonHint?: string;
    };
    expect(corePayload.status).toBe("delegation_fallback");
    expect(corePayload.stopReasonHint).toBe("budget_exceeded");

    const cliPayload = JSON.parse(
      result.context.results.implement_cli ?? "{}",
    ) as {
      status?: string;
      stopReasonHint?: string;
      unmetDependencies?: Array<{ stepName?: string }>;
    };
    expect(cliPayload.status).toBe("dependency_blocked");
    expect(cliPayload.stopReasonHint).toBe("budget_exceeded");
    expect(cliPayload.unmetDependencies?.[0]?.stepName).toBe("implement_core");
  });

  it("retries child validation failures that return non-completed stop reasons without tool evidence", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Execution stopped before completion (validation_error).",
          success: false,
          durationMs: 12,
          toolCalls: [],
          stopReason: "validation_error",
          stopReasonDetail:
            "Delegated task required successful tool-grounded evidence but child reported no tool calls",
        },
      },
      {
        delayMs: 5,
        result: {
          output:
            '{"summary":"Return JSON object with evidence collected"}',
          success: true,
          durationMs: 11,
          toolCalls: [{
            name: "system.readFile",
            args: { path: "/tmp/ci.log" },
            result: '{"content":"evidence"}',
            isError: false,
            durationMs: 2,
          }],
          stopReason: "completed",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-stop-reason:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_contract",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return JSON object",
          acceptanceCriteria: ["Return JSON object"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(2);
    expect(manager.spawnCalls[1]?.task).toContain("Retry corrections (attempt 1)");
    expect(result.context.results.delegate_contract).toContain("evidence collected");
  });

  it("accepts provider-native search citations for research subagent steps", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            '{"selected":"pixi","citations":["https://pixijs.com","https://docs.phaser.io"]}',
          success: true,
          durationMs: 9,
          toolCalls: [],
          providerEvidence: {
            citations: ["https://pixijs.com", "https://docs.phaser.io"],
          },
          stopReason: "completed",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveAvailableToolNames: () => ["web_search"],
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-native-search:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "tech_research",
          stepType: "subagent_task",
          objective:
            "Compare Canvas API, Phaser, and PixiJS from official docs",
          inputContract:
            "Return JSON with selected framework and citations",
          acceptanceCriteria: ["Include citations"],
          requiredToolCapabilities: ["web_search"],
          contextRequirements: ["official_docs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
  });

  it("preserves non-completed child stop reasons instead of reclassifying them as malformed JSON", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Execution stopped before completion (tool_calls).",
          success: false,
          durationMs: 12,
          toolCalls: [{
            name: "mcp.browser.browser_tabs",
            args: { action: "list" },
            result: "### Result\n- 0: (current) [](about:blank)",
            isError: false,
            durationMs: 1,
          }],
          stopReason: "no_progress",
          stopReasonDetail:
            "Execution stopped before completion (tool_calls). Reached max tool rounds (10).",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-no-progress:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_contract",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return JSON object",
          acceptanceCriteria: ["Return JSON object"],
          requiredToolCapabilities: ["mcp.browser.browser_navigate"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Execution stopped before completion");
    expect(result.error?.toLowerCase()).not.toContain("malformed result contract");
  });

  it("retries and fails when acceptance-count contract checks are violated", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            '{"references":[{"url":"a"},{"url":"b"},{"url":"c"},{"url":"d"}]}',
          success: true,
          durationMs: 12,
          toolCalls: [{
            name: "playwright.browser_snapshot",
            args: { locator: "body" },
            result: '{"ok":true}',
            isError: false,
            durationMs: 3,
          }],
        },
      },
      {
        delayMs: 5,
        result: {
          output:
            '{"references":[{"url":"a"},{"url":"b"},{"url":"c"},{"url":"d"}]}',
          success: true,
          durationMs: 11,
          toolCalls: [{
            name: "playwright.browser_snapshot",
            args: { locator: "body" },
            result: '{"ok":true}',
            isError: false,
            durationMs: 3,
          }],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-count:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_contract",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return JSON object with references",
          acceptanceCriteria: ["Exactly 3 references with valid URLs"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error?.toLowerCase()).toContain("expected exactly 3 references");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(manager.spawnCalls).toHaveLength(2);
  });

  it("uses parent fallback path after bounded transient-provider retries", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Provider error: fetch failed",
          success: false,
          durationMs: 20,
          toolCalls: [],
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Provider error: temporarily unavailable",
          success: false,
          durationMs: 21,
          toolCalls: [],
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Provider error: connection reset",
          success: false,
          durationMs: 22,
          toolCalls: [],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "continue_without_delegation",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-fallback:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_fallback",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(3);
    const payload = JSON.parse(
      result.context.results.delegate_fallback ?? "{}",
    ) as {
      status?: string;
      failureClass?: string;
      recoveredViaParentFallback?: boolean;
      attempts?: number;
    };
    expect(payload.status).toBe("delegation_fallback");
    expect(payload.failureClass).toBe("transient_provider_error");
    expect(payload.recoveredViaParentFallback).toBe(true);
    expect(payload.attempts).toBe(3);
  });

  it("does not retry tool-misuse failures and returns tool_error stop reason hint", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            "Tool call validation failed: missing required argument 'command' for system.bash",
          success: false,
          durationMs: 12,
          toolCalls: [],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-c4-tool-misuse:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_tool_misuse",
          stepType: "subagent_task",
          objective: "Analyze logs",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.bash"],
          contextRequirements: ["ci_logs"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("tool_error");
    expect(manager.spawnCalls).toHaveLength(1);
  });
});
