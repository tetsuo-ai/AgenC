import { describe, it, expect, vi } from "vitest";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor.js";
import { InMemoryDelegationTrajectorySink } from "../llm/delegation-learning.js";
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
    this.entries.set(id, {
      readyAt: Date.now() + this.delayMs,
      delivered: false,
      result: {
        sessionId: id,
        output: this.shouldSucceed
          ? `done:${id}`
          : `failed:${id}`,
        success: this.shouldSucceed,
        durationMs: this.delayMs,
        toolCalls: [],
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
    expect(result.context.results.delegate_a).toContain("done:sub-1");
    expect(result.context.results.run_tool).toContain('"step":"run_tool"');
    expect(fallback.execute).toHaveBeenCalledTimes(1);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.parentSessionId).toBe("session-1");
    expect(manager.spawnCalls[0]?.requiredCapabilities).toEqual([
      "system.readFile",
    ]);
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

  it("fails fast when planner subagent depth exceeds hard cap", async () => {
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

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(result.error).toContain("exceeds maxDepth 1");
    expect(manager.spawnCalls).toHaveLength(0);
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
          output: "done",
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
          output: "done",
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
          output: "recovered after retry",
          success: true,
          durationMs: 10,
          toolCalls: [],
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
          inputContract: "Return JSON object with findings",
          acceptanceCriteria: ["Include findings array"],
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
