import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { DeterministicPipelineExecutor } from "../llm/chat-executor.js";
import { InMemoryDelegationTrajectorySink } from "../llm/delegation-learning.js";
import { derivePromptBudgetPlan } from "../llm/prompt-budget.js";
import type {
  Pipeline,
  PipelinePlannerSubagentStep,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { SubAgentConfig, SubAgentResult } from "./sub-agent.js";
import { SubAgentOrchestrator } from "./subagent-orchestrator.js";

const TEMP_DIRS_TO_CLEAN: string[] = [];

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

afterEach(() => {
  while (TEMP_DIRS_TO_CLEAN.length > 0) {
    const path = TEMP_DIRS_TO_CLEAN.pop();
    if (!path) continue;
    rmSync(path, { recursive: true, force: true });
  }
});

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

  it("emits parent pipeline events for delegated DAG steps", async () => {
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
    const events: Array<Record<string, unknown>> = [];

    const result = await orchestrator.execute(
      {
        id: "planner:session-trace:123",
        createdAt: Date.now(),
        context: { results: {} },
        steps: [],
        plannerSteps: [
          {
            name: "scaffold_workspace",
            stepType: "subagent_task",
            objective: "Author package manifests and workspace config",
            inputContract: "Empty workspace",
            acceptanceCriteria: ["All manifests and configs authored"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/workspace/trace-lab"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
        ],
      },
      0,
      {
        onEvent: (event) => {
          events.push(event as Record<string, unknown>);
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_started",
          stepName: "scaffold_workspace",
          stepIndex: 0,
          tool: "execute_with_agent",
          args: expect.objectContaining({
            objective: "Author package manifests and workspace config",
            inputContract: "Empty workspace",
            acceptanceCriteria: ["All manifests and configs authored"],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/workspace/trace-lab"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          }),
        }),
        expect.objectContaining({
          type: "step_finished",
          stepName: "scaffold_workspace",
          stepIndex: 0,
          tool: "execute_with_agent",
          durationMs: expect.any(Number),
          result: expect.stringContaining('"status":"completed"'),
        }),
      ]),
    );
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

  it("preserves write and shell tools for planner-emitted web implementation steps", async () => {
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
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "web_search",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-web-tools:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_web",
          stepType: "subagent_task",
          objective:
            "Create Vite TS app in packages/web with map editor UI, in-browser solver using core, canvas visualization of path and cost.",
          inputContract: "Scaffolded web with core dep",
          acceptanceCriteria: [
            "Vite config and basic interactive app with edit/solve/visualize flow",
          ],
          requiredToolCapabilities: ["file_system_write"],
          contextRequirements: ["cwd=/workspace/transit-weave-ts-29"],
          maxBudgetHint: "6m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest:
          "Build a TypeScript monorepo with packages core, cli, and web.",
        history: [],
        memory: [],
        toolOutputs: [],
        parentAllowedTools: [
          "system.bash",
          "system.readFile",
          "system.writeFile",
          "web_search",
        ],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
  });

  it("keeps child tool scope out of the delegated contract spec", async () => {
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
      resolveAvailableToolNames: () => [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.browse",
      ],
    });

    await orchestrator.execute({
      id: "planner:session-contract-scope-separation:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "design_research",
          stepType: "subagent_task",
          objective:
            "Define the simulator data model and write the initial DESIGN.md artifact",
          inputContract: "Fresh workspace",
          acceptanceCriteria: ["DESIGN.md created with key entities"],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: ["cwd=/workspace/freight-flow-ts"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      plannerContext: {
        parentRequest:
          "Build a TypeScript monorepo and later validate the web flows in Chromium.",
        history: [],
        memory: [],
        toolOutputs: [],
        parentAllowedTools: [
          "system.bash",
          "system.readFile",
          "system.writeFile",
          "system.browse",
        ],
      },
    });

    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.tools).toEqual(
      expect.arrayContaining([
        "system.writeFile",
        "system.readFile",
        "system.bash",
      ]),
    );
    expect(manager.spawnCalls[0]?.delegationSpec?.tools).toBeUndefined();
    expect(manager.spawnCalls[0]?.delegationSpec?.requiredToolCapabilities).toEqual([
      "system.bash",
      "system.readFile",
      "system.writeFile",
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
    const lifecycleEvents: Array<Record<string, unknown>> = [];
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
      resolveLifecycleEmitter: () => ({
        emit: (event: Record<string, unknown>) => lifecycleEvents.push(event),
      } as any),
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
    expect(result.error).toContain("stepTokens=130");
    expect(result.error).toContain("cumulativeTokens=130/100");
    const breakerEvent = lifecycleEvents.find(
      (event) => event.type === "subagents.failed",
    );
    expect(breakerEvent).toBeDefined();
    expect(breakerEvent?.payload).toEqual(
      expect.objectContaining({
        stepName: "delegate_token_cap",
        stage: "circuit_breaker",
        reason: "max cumulative child tokens per request tree exceeded (100)",
        limitKind: "tokens",
        stepTokens: 130,
        stepToolCalls: 0,
        cumulativeTokens: 130,
        maxCumulativeTokensPerRequestTree: 100,
        cumulativeToolCalls: 0,
      }),
    );
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

  it("scales the default child-token budget with planner max_budget_hint durations", async () => {
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
          output: "Included findings from the first long-running coding phase",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.writeFile",
            args: { path: "/tmp/a.ts", content: "export {};\n" },
            result: '{"path":"/tmp/a.ts","bytesWritten":11}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 300_000,
            completionTokens: 50_000,
            totalTokens: 350_000,
          },
        },
      },
      {
        delayMs: 5,
        result: {
          output: "Included findings from the second long-running coding phase",
          success: true,
          durationMs: 10,
          toolCalls: [{
            name: "system.writeFile",
            args: { path: "/tmp/b.ts", content: "export {};\n" },
            result: '{"path":"/tmp/b.ts","bytesWritten":11}',
            isError: false,
            durationMs: 1,
          }],
          tokenUsage: {
            promptTokens: 300_000,
            completionTokens: 50_000,
            totalTokens: 350_000,
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
      id: "planner:session-token-hints:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_core_impl",
          stepType: "subagent_task",
          objective: "Implement a large core coding phase",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["workspace_files"],
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
        {
          name: "delegate_cli_impl",
          stepType: "subagent_task",
          objective: "Implement a large CLI coding phase",
          inputContract: "Return findings",
          acceptanceCriteria: ["Include findings"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["workspace_files"],
          maxBudgetHint: "8m",
          canRunParallel: true,
          dependsOn: ["delegate_core_impl"],
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
              "Sensitive outputs reference absolute path /home/tetsuo/.ssh/id_rsa and data:image/png;base64,AAAA",
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

  it("does not inject planner memory into child prompts unless an explicit memory source is requested", async () => {
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
      id: "planner:session-no-memory-default:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_repo_task",
          stepType: "subagent_task",
          objective: "Implement the CLI entrypoint from the existing package layout",
          inputContract: "Use the repo files only and return a concise summary",
          acceptanceCriteria: ["CLI entrypoint created"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest: "Build the CLI package and keep scope inside the repo.",
        history: [
          {
            role: "user",
            content: "Please implement the CLI package.",
          },
        ],
        memory: [
          {
            source: "memory_semantic",
            content: "Solana validator RPC defaults to devnet in a different project.",
          },
          {
            source: "memory_episodic",
            content: "We discussed wallet adapter UX yesterday.",
          },
        ],
        toolOutputs: [],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).not.toContain("[memory_semantic]");
    expect(prompt).not.toContain("[memory_episodic]");
    expect(prompt).not.toContain("Solana validator RPC defaults");
    expect(prompt).not.toContain("wallet adapter UX");
    expect(prompt).toContain(
      '"memory":{"selected":0,"available":2,"omitted":2,"truncated":false}',
    );
  });

  it("filters explicit semantic memory requests by delegated step relevance", async () => {
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
      id: "planner:session-memory-relevance:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_analysis",
          stepType: "subagent_task",
          objective: "Analyze CI failure clusters and propose remediation",
          inputContract: "Return clustered findings with evidence",
          acceptanceCriteria: ["At least 2 CI failure clusters"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["ci_logs", "memory_semantic"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      plannerContext: {
        parentRequest: "Diagnose the latest CI failures and point to likely fixes.",
        history: [],
        memory: [
          {
            source: "memory_semantic",
            content: "CI failures cluster around flaky integration tests on main.",
          },
          {
            source: "memory_semantic",
            content: "Solana validator RPC defaults to devnet in a different workspace.",
          },
        ],
        toolOutputs: [],
      },
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const prompt = manager.spawnCalls[0]?.task ?? "";
    expect(prompt).toContain("[memory_semantic] CI failures cluster around flaky integration tests on main.");
    expect(prompt).not.toContain("Solana validator RPC defaults");
    expect(prompt).toContain(
      '"memory":{"selected":1,"available":2,"omitted":1,"truncated":false}',
    );
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
    expect(taskPrompt).toContain("\"modifiedFiles\":[\"/workspace/project/src/cli.ts\"]");
    expect(taskPrompt).not.toContain("\"toolCalls\"");
    expect(taskPrompt).not.toContain("\"tokenUsage\"");
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

  it("deduplicates dependency artifacts across absolute and relative workspace paths", async () => {
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
    });

    const pipeline: Pipeline = {
      id: "planner:session-dependency-artifact-dedupe:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_workspace",
          stepType: "subagent_task",
          objective: "Author root and package manifests for the workspace",
          inputContract: "Empty workspace",
          acceptanceCriteria: ["Workspace manifests exist"],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement packages/core and make it build cleanly",
          inputContract: "Workspace scaffolded",
          acceptanceCriteria: ["Core package builds cleanly"],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "6m",
          canRunParallel: false,
          dependsOn: ["scaffold_workspace"],
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Implement packages/cli using the core package",
          inputContract: "Core ready",
          acceptanceCriteria: ["CLI compiles cleanly"],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: ["cwd=/workspace/terrain-router-ts"],
          maxBudgetHint: "6m",
          canRunParallel: false,
          dependsOn: ["implement_core"],
        },
      ],
      plannerContext: {
        parentRequest:
          "Create /workspace/terrain-router-ts from scratch as a TypeScript npm workspace monorepo.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const scaffoldResult = JSON.stringify({
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/package.json",
            content:
              '{ "name": "@terrain-router/core", "scripts": { "test": "echo \\"no tests yet\\"" } }',
          },
        },
      ],
    });
    const coreResult = JSON.stringify({
      toolCalls: [
        {
          name: "system.readFile",
          args: {
            path: "packages/core/package.json",
          },
          result: JSON.stringify({
            path: "/workspace/terrain-router-ts/packages/core/package.json",
            content:
              '{ "name": "@terrain-router/core", "scripts": { "test": "echo \\"no tests yet\\"" } }',
          }),
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/package.json",
            content:
              '{ "name": "@terrain-router/core", "scripts": { "test": "vitest run" } }',
          },
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
        scaffold_workspace: scaffoldResult,
        implement_core: coreResult,
      },
      toolScope,
    );

    expect(taskPrompt).toContain(
      "[artifact:implement_core:packages/core/package.json]",
    );
    expect(taskPrompt).toContain('"test": "vitest run"');
    expect(taskPrompt).not.toContain(
      "[artifact:scaffold_workspace:packages/core/package.json]",
    );
    expect(taskPrompt).not.toContain(
      "[artifact:implement_core:/workspace/terrain-router-ts/packages/core/package.json]",
    );
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
    expect(taskPrompt).toContain("Project-local CLIs such as `tsc`, `vite`, `vitest`, and `eslint`");
    expect(taskPrompt).toContain("workspace:*");
    expect(taskPrompt).toContain("\"hostTooling\":{");
    expect(taskPrompt).toContain("\"npmWorkspaceProtocolSupport\":\"unsupported\"");
  });

  it("surfaces empty package source gaps before verification in implementation prompts", async () => {
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

    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "subagent-empty-package-guidance-"),
    );
    TEMP_DIRS_TO_CLEAN.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, "packages", "core", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(workspaceRoot, "packages", "core", "package.json"),
      '{ "name": "@signal-cartography/core", "scripts": { "build": "tsc -p tsconfig.json" } }',
    );
    writeFileSync(
      join(workspaceRoot, "packages", "core", "tsconfig.json"),
      '{ "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src/**/*"] }',
    );

    const pipeline: Pipeline = {
      id: "planner:session-empty-package-guidance:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_workspace",
          stepType: "subagent_task",
          objective: "Author workspace scaffold and package manifests.",
          inputContract: "Empty workspace.",
          acceptanceCriteria: ["Workspace scaffolded."],
          requiredToolCapabilities: ["system.writeFile", "system.readFile"],
          contextRequirements: [`cwd=${workspaceRoot}`],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "implement_core",
          stepType: "subagent_task",
          dependsOn: ["scaffold_workspace"],
          objective: "Implement packages/core and make it build cleanly.",
          inputContract: "Workspace scaffolded.",
          acceptanceCriteria: ["Core package builds cleanly."],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: [`cwd=${workspaceRoot}`],
          maxBudgetHint: "6m",
          canRunParallel: false,
        },
        {
          name: "run_build",
          stepType: "deterministic_tool",
          dependsOn: ["implement_core"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@signal-cartography/core"],
            cwd: workspaceRoot,
          },
          onError: "abort",
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript monorepo in the provided workspace and make the core package build.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const scaffoldResult = JSON.stringify({
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/package.json",
            content:
              '{ "name": "@signal-cartography/core", "scripts": { "build": "tsc -p tsconfig.json" } }',
          },
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/tsconfig.json",
            content:
              '{ "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src/**/*"] }',
          },
        },
      ],
    });

    const step = pipeline.plannerSteps[1]!;
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
      { scaffold_workspace: scaffoldResult },
      toolScope,
    );

    expect(taskPrompt).toContain("Observed workspace state:");
    expect(taskPrompt).toContain(
      "`packages/core/src` exists but has no authored source files yet.",
    );
    expect(taskPrompt).toContain(
      "Execution ordering: author the missing source files for this phase before invoking any verification command.",
    );
  });

  it("tells research children to return inline textual artifacts when no file-write tools are allowed", async () => {
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
      resolveAvailableToolNames: () => ["system.browse"],
      allowedParentTools: ["system.browse"],
    });

    const pipeline: Pipeline = {
      id: "planner:session-inline-design-doc:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "design_research",
          stepType: "subagent_task",
          objective:
            "Research reference systems and define the simulator data model",
          inputContract:
            "Return a concise design document with references and extracted findings",
          acceptanceCriteria: [
            "Design document outlining Network, Train, Job, and SimulationState",
          ],
          requiredToolCapabilities: ["system.browse"],
          contextRequirements: ["cwd=/workspace/freight-flow-ts"],
          maxBudgetHint: "3m",
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

    expect(taskPrompt).toContain("Output contract:");
    expect(taskPrompt).toContain(
      "return that artifact inline in your response",
    );
    expect(taskPrompt).toContain(
      "Do not block solely because you cannot persist a workspace file",
    );
  });

  it("summarizes dependency results structurally instead of replaying verbose child prose", async () => {
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
    });

    const pipeline: Pipeline = {
      id: "planner:session-structural-dependency-summary:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective: "Implement packages/core pathfinding",
          inputContract: "Only edit packages/core",
          acceptanceCriteria: ["Core builds cleanly"],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: ["cwd=/workspace/maze-forge"],
          maxBudgetHint: "5m",
        },
        {
          name: "implement_cli",
          stepType: "subagent_task",
          objective: "Implement packages/cli using the core exports",
          inputContract: "Only edit packages/cli",
          acceptanceCriteria: ["CLI builds cleanly"],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: ["cwd=/workspace/maze-forge"],
          maxBudgetHint: "3m",
          dependsOn: ["implement_core"],
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript monorepo with packages/core and packages/cli.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    };

    const coreResult = JSON.stringify({
      status: "completed",
      success: true,
      durationMs: 12_345,
      output:
        "**Phase `implement_core` complete**\n\n- This is a long natural-language status block that should not be copied wholesale into downstream child prompts.\n- It contains prose, verification notes, and unrelated narration.",
      tokenUsage: {
        totalTokens: 743_388,
      },
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/src/index.ts",
            content: "export const value = 1;\n",
          },
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/core/src/index.test.ts",
            content: "import { expect, test } from 'vitest';\n",
          },
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["--prefix", "packages/core", "run", "build"],
          },
          result: JSON.stringify({ exitCode: 0 }),
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["--prefix", "packages/core", "run", "test"],
          },
          result: JSON.stringify({ exitCode: 0 }),
        },
      ],
    });

    const step = pipeline.plannerSteps[1]!;
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
      { implement_core: coreResult },
      toolScope,
    );

    expect(taskPrompt).toContain(
      '"modifiedFiles":["packages/core/src/index.ts","packages/core/src/index.test.ts"]',
    );
    expect(taskPrompt).toContain(
      '"verifiedCommands":["npm --prefix packages/core run build","npm --prefix packages/core run test"]',
    );
    expect(taskPrompt).not.toContain("743388");
    expect(taskPrompt).not.toContain("should not be copied wholesale");
  });

  it("keeps dependency verification commands in their final resolved bucket", async () => {
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
    });

    const summary = (
      orchestrator as unknown as {
        summarizeDependencyResultForPrompt: (result: string | null) => string;
      }
    ).summarizeDependencyResultForPrompt(
      JSON.stringify({
        status: "completed",
        success: true,
        toolCalls: [
          {
            name: "system.bash",
            args: {
              command: "npm",
              args: ["--prefix", "packages/core", "run", "test"],
            },
            result: JSON.stringify({ exitCode: 1 }),
          },
          {
            name: "system.bash",
            args: {
              command: "npm",
              args: ["--prefix", "packages/core", "run", "build"],
            },
            result: JSON.stringify({ exitCode: 0 }),
          },
          {
            name: "system.bash",
            args: {
              command: "npm",
              args: ["--prefix", "packages/core", "run", "test"],
            },
            result: JSON.stringify({ exitCode: 0 }),
          },
        ],
      }),
    );

    const parsed = JSON.parse(summary) as {
      verifiedCommands?: string[];
      failedCommands?: string[];
    };
    expect(parsed.verifiedCommands).toEqual([
      "npm --prefix packages/core run test",
      "npm --prefix packages/core run build",
    ]);
    expect(parsed.failedCommands ?? []).toEqual([]);
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
      "Do not use globbed selectors such as `--workspace=packages/*`.",
    );
    expect(taskPrompt).toContain(
      "prefer a package-local `tsconfig.json` (or project references) for each buildable package",
    );
    expect(taskPrompt).toContain(
      "[artifact:setup_project_structure:packages/cli/package.json]",
    );
    expect(taskPrompt).toContain(
      "[artifact:implement_core_logic:packages/core/src/index.ts]",
    );
  });

  it("falls back to scored live workspace artifacts when dependency results lack file snapshots", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-subagent-workspace-"));
    TEMP_DIRS_TO_CLEAN.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(workspaceRoot, "packages", "core", "src"), { recursive: true });
    mkdirSync(join(workspaceRoot, "packages", "data", "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
        scripts: { build: "npm run build --workspaces" },
      }),
    );
    writeFileSync(
      join(workspaceRoot, "packages", "cli", "package.json"),
      JSON.stringify({
        name: "cli",
        dependencies: {
          core: "file:../core",
          data: "file:../data",
        },
      }),
    );
    writeFileSync(
      join(workspaceRoot, "packages", "core", "src", "index.ts"),
      "export function dijkstra() { return 'ok'; }\n",
    );
    writeFileSync(
      join(workspaceRoot, "packages", "data", "src", "index.ts"),
      "export function loadScenario() { return []; }\n",
    );

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
    });

    const pipeline: Pipeline = {
      id: "planner:session-live-workspace-artifacts:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "repair_cli",
          stepType: "subagent_task",
          objective:
            "Narrowly repair/implement CLI in packages/cli: simulate+benchmark cmds with JSON/table output using core/data routing",
          inputContract:
            "Root workspaces and packages/core+data already present with file: compatible manifests",
          acceptanceCriteria: [
            "packages/cli/package.json with bin+file:../core deps",
            "src/cli.ts handlers for commands",
            "tsc clean",
          ],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
          ],
          contextRequirements: [`cwd=${workspaceRoot}`],
          maxBudgetHint: "4m",
          canRunParallel: false,
        },
      ],
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
    }).buildSubagentTaskPrompt(
      step,
      pipeline,
      {},
      toolScope,
    );

    expect(taskPrompt).toContain("Dependency-derived workspace context:");
    expect(taskPrompt).toContain(
      "[artifact:workspace_context:packages/cli/package.json]",
    );
    expect(taskPrompt).toContain(
      "[artifact:workspace_context:packages/core/src/index.ts]",
    );
    expect(taskPrompt).toContain("\"dependencyArtifacts\":{");
    expect(taskPrompt).toContain("\"available\":");
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
    expect(taskPrompt).toContain(
      "If this phase authors the root workspace manifest or scaffold, define the downstream root npm scripts now: `test`, `build`.",
    );
    expect(taskPrompt).toContain(
      "Do not leave those root script definitions for a later implementation-only step",
    );
  });

  it("adds derived pre-install scaffold constraints to child prompts and delegation specs", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      }),
      pollIntervalMs: 5,
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => [
        "system.writeFile",
        "system.listDir",
        "system.bash",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-preinstall-constraints:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_manifests",
          stepType: "subagent_task",
          objective:
            "Author package.json, tsconfig.json, vite config, README skeleton, and src placeholders for the workspace.",
          inputContract: "Create the monorepo from scratch.",
          acceptanceCriteria: [
            "All manifests and configs authored with local file dependencies.",
          ],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.listDir",
            "system.bash",
          ],
          contextRequirements: ["cwd=/workspace/freight-flow"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "npm_install",
          stepType: "deterministic_tool",
          dependsOn: ["scaffold_manifests"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
            cwd: "/workspace/freight-flow",
          },
        },
        {
          name: "run_tests",
          stepType: "deterministic_tool",
          dependsOn: ["npm_install"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["test"],
            cwd: "/workspace/freight-flow",
          },
        },
        {
          name: "run_build",
          stepType: "deterministic_tool",
          dependsOn: ["run_tests"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/workspace/freight-flow",
          },
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript workspace in /workspace/freight-flow and verify it with npm test and npm run build.",
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
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: {
          allowedTools: readonly string[];
          allowsToollessExecution: boolean;
          semanticFallback: readonly string[];
          removedLowSignalBrowserTools: readonly string[];
          removedByPolicy: readonly string[];
          removedAsDelegationTools: readonly string[];
          removedAsUnknownTools: readonly string[];
          parentPolicyAllowed: readonly string[];
        },
      ) => { taskPrompt: string };
      buildEffectiveDelegationSpec: (
        step: PipelinePlannerSubagentStep,
        pipeline: Pipeline,
        options?: {
          readonly parentRequest?: string;
          readonly lastValidationCode?: string;
          readonly delegatedWorkingDirectory?: string;
        },
      ) => {
        acceptanceCriteria?: readonly string[];
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
    const delegationSpec = (orchestrator as unknown as {
      buildEffectiveDelegationSpec: (
        step: PipelinePlannerSubagentStep,
        pipeline: Pipeline,
        options?: {
          readonly parentRequest?: string;
          readonly lastValidationCode?: string;
          readonly delegatedWorkingDirectory?: string;
        },
      ) => { acceptanceCriteria?: readonly string[] };
    }).buildEffectiveDelegationSpec(step, pipeline, {
      parentRequest: pipeline.plannerContext?.parentRequest,
      delegatedWorkingDirectory: "/workspace/freight-flow",
    });

    expect(
      delegationSpec.acceptanceCriteria,
    ).toEqual(
      expect.arrayContaining([
        "Root package.json authored with npm scripts for test, build.",
        "Buildable TypeScript workspace packages use package-local tsconfig/project references or equivalent so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling packages.",
        "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
        "No `workspace:*` dependency specifiers used; use `file:` local dependency references instead.",
      ]),
    );
    expect(taskPrompt).toContain(
      "Root package.json authored with npm scripts for test, build.",
    );
    expect(taskPrompt).toContain(
      "Buildable TypeScript workspace packages use package-local tsconfig/project references or equivalent so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling packages.",
    );
    expect(taskPrompt).toContain(
      "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
    );
  });

  it("adds derived pre-install constraints to implementation steps that occur before the real install step", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => ({
      status: "completed",
      context: pipeline.context,
      completedSteps: pipeline.steps.length,
      totalSteps: pipeline.steps.length,
    }));
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => null,
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      }),
      pollIntervalMs: 5,
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => [
        "system.writeFile",
        "system.listDir",
        "system.bash",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-preinstall-implementation-constraints:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective:
            "Implement the TypeScript core package with package.json, tsconfig.json, and routing source files.",
          inputContract: "Scaffolded workspace root exists.",
          acceptanceCriteria: [
            "Core package exports the routing primitives and TypeScript sources.",
          ],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.listDir",
            "system.bash",
          ],
          contextRequirements: ["cwd=/workspace/freight-flow"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "npm_install",
          stepType: "deterministic_tool",
          dependsOn: ["implement_core"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
            cwd: "/workspace/freight-flow",
          },
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript workspace in /workspace/freight-flow, then install dependencies after package implementation.",
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
      buildSubagentTaskPrompt: (
        step: Pipeline["plannerSteps"][number],
        pipeline: Pipeline,
        results: Readonly<Record<string, string>>,
        toolScope: {
          allowedTools: readonly string[];
          allowsToollessExecution: boolean;
          semanticFallback: readonly string[];
          removedLowSignalBrowserTools: readonly string[];
          removedByPolicy: readonly string[];
          removedAsDelegationTools: readonly string[];
          removedAsUnknownTools: readonly string[];
          parentPolicyAllowed: readonly string[];
        },
      ) => { taskPrompt: string };
      buildEffectiveDelegationSpec: (
        step: PipelinePlannerSubagentStep,
        pipeline: Pipeline,
        options?: {
          readonly parentRequest?: string;
          readonly lastValidationCode?: string;
          readonly delegatedWorkingDirectory?: string;
        },
      ) => {
        acceptanceCriteria?: readonly string[];
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
    const delegationSpec = (orchestrator as unknown as {
      buildEffectiveDelegationSpec: (
        step: PipelinePlannerSubagentStep,
        pipeline: Pipeline,
        options?: {
          readonly parentRequest?: string;
          readonly lastValidationCode?: string;
          readonly delegatedWorkingDirectory?: string;
        },
      ) => { acceptanceCriteria?: readonly string[] };
    }).buildEffectiveDelegationSpec(step, pipeline, {
      parentRequest: pipeline.plannerContext?.parentRequest,
      delegatedWorkingDirectory: "/workspace/freight-flow",
    });

    expect(
      delegationSpec.acceptanceCriteria,
    ).toEqual(
      expect.arrayContaining([
        "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
      ]),
    );
    expect(taskPrompt).toContain(
      "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
    );
  });

  it("derives multiple downstream root npm scripts from a combined shell-mode verification step", () => {
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
      childToolAllowlistStrategy: "inherit_intersection",
      resolveAvailableToolNames: () => [
        "system.writeFile",
        "system.listDir",
        "system.bash",
      ],
    });

    const pipeline: Pipeline = {
      id: "planner:session-combined-root-scripts:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_workspace",
          stepType: "subagent_task",
          objective:
            "Author the workspace manifests and config files for the monorepo.",
          inputContract: "Create the monorepo from scratch.",
          acceptanceCriteria: ["All manifests and configs authored."],
          requiredToolCapabilities: ["system.writeFile", "system.listDir"],
          contextRequirements: ["cwd=/workspace/freight-flow"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "build_test_validate",
          stepType: "deterministic_tool",
          dependsOn: ["scaffold_workspace"],
          tool: "system.bash",
          args: {
            command: "npm run build --if-present && npm test --if-present",
            cwd: "/workspace/freight-flow",
          },
          onError: "abort",
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript workspace in /workspace/freight-flow and verify it with npm run build and npm test.",
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
      "If this phase authors the root workspace manifest or scaffold, define the downstream root npm scripts now: `build`, `test`.",
    );
    expect(taskPrompt).toContain(
      "Root package.json authored with npm scripts for build, test.",
    );
    expect(taskPrompt).toContain(
      "Buildable TypeScript workspace packages use package-local tsconfig/project references or equivalent so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling packages.",
    );
  });

  it("rejects scaffold child results that run npm install before the downstream install step", async () => {
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
            "**Phase `scaffold_manifests` completed.** Verified npm install succeeded for the authored workspace scaffold.",
          success: true,
          durationMs: 12,
          toolCalls: [{
            name: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
            },
            result: '{"exitCode":0,"stdout":"installed","stderr":""}',
            isError: false,
            durationMs: 1,
          }],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      }),
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-preinstall-validation:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_manifests",
          stepType: "subagent_task",
          objective:
            "Author package.json, tsconfig.json, vite config, README skeleton, and src placeholders for the workspace.",
          inputContract: "Create the monorepo from scratch.",
          acceptanceCriteria: [
            "All manifests and configs authored with local file dependencies.",
          ],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/workspace/freight-flow"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "npm_install",
          stepType: "deterministic_tool",
          dependsOn: ["scaffold_manifests"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
            cwd: "/workspace/freight-flow",
          },
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript workspace in /workspace/freight-flow and install dependencies after the scaffold phase.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(result.error?.toLowerCase()).toContain(
      "forbids dependency-install commands",
    );
    expect(manager.spawnCalls[0]?.delegationSpec?.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
      ]),
    );
  });

  it("rejects implementation child results that run npm install before the downstream install step", async () => {
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
            "**Phase `implement_core` completed.** Verified npm install succeeded before writing the core package files.",
          success: true,
          durationMs: 12,
          toolCalls: [{
            name: "system.bash",
            args: {
              command: "npm",
              args: ["install", "--save-dev", "typescript@^5.5.0"],
            },
            result: '{"exitCode":0,"stdout":"installed","stderr":""}',
            isError: false,
            durationMs: 1,
          }],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveHostToolingProfile: () => ({
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      }),
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-preinstall-implementation-validation:123",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          objective:
            "Implement the TypeScript core package with package.json, tsconfig.json, and routing source files.",
          inputContract: "Scaffolded workspace root exists.",
          acceptanceCriteria: [
            "Core package exports the routing primitives and TypeScript sources.",
          ],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/workspace/freight-flow"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "npm_install",
          stepType: "deterministic_tool",
          dependsOn: ["implement_core"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
            cwd: "/workspace/freight-flow",
          },
        },
      ],
      plannerContext: {
        parentRequest:
          "Create a TypeScript workspace in /workspace/freight-flow and install dependencies only after package implementation.",
        history: [],
        memory: [],
        toolOutputs: [],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.stopReasonHint).toBe("validation_error");
    expect(result.error?.toLowerCase()).toContain(
      "forbids dependency-install commands",
    );
    expect(manager.spawnCalls[0]?.delegationSpec?.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
      ]),
    );
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

  it("adapts low-signal browser retry guidance for host-only localhost validation", () => {
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
      fallbackBehavior: "fail_request",
    });

    const step: PipelinePlannerSubagentStep = {
      name: "qa_and_validation",
      stepType: "subagent_task",
      objective:
        "Validate the localhost web flows in Chromium and report grounded evidence.",
      acceptanceCriteria: [
        "Chromium validation of the localhost UI",
      ],
      requiredToolCapabilities: ["system.bash", "system.browserSessionStart"],
      canRunParallel: false,
    };

    const prompt = (orchestrator as unknown as {
      buildRetryTaskPrompt: (
        currentTaskPrompt: string,
        step: PipelinePlannerSubagentStep,
        allowedTools: readonly string[],
        failure: {
          failureClass: "malformed_result_contract";
          message: string;
          stopReasonHint: "validation_error";
          validationCode: "low_signal_browser_evidence";
        },
        retryAttempt: number,
      ) => string;
    }).buildRetryTaskPrompt(
      "Base prompt",
      step,
      ["system.bash", "system.browserSessionStart"],
      {
        failureClass: "malformed_result_contract",
        message:
          "Delegated task required browser-grounded evidence but child only used low-signal browser state checks",
        stopReasonHint: "validation_error",
        validationCode: "low_signal_browser_evidence",
      },
      1,
    );

    expect(prompt).toContain("do not use `system.browse` or `system.browserSession*`");
    expect(prompt).toContain("host-side browser verification command");
    expect(prompt).toContain("system.bash");
  });

  it("adds browser-evidence retry guidance when acceptance evidence is missing for browser-required work", () => {
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
      fallbackBehavior: "fail_request",
    });

    const step: PipelinePlannerSubagentStep = {
      name: "implement_web",
      stepType: "subagent_task",
      objective:
        "Implement packages/web: Vite+React with 2 demo scenarios, JSON editor, timeline render, validation errors",
      inputContract: "Installed deps + core",
      acceptanceCriteria: [
        "App builds and demos functional",
      ],
      requiredToolCapabilities: ["system.bash", "system.browserSessionStart"],
      canRunParallel: false,
    };

    const prompt = (orchestrator as unknown as {
      buildRetryTaskPrompt: (
        currentTaskPrompt: string,
        step: PipelinePlannerSubagentStep,
        allowedTools: readonly string[],
        failure: {
          failureClass: "malformed_result_contract";
          message: string;
          stopReasonHint: "validation_error";
          validationCode: "acceptance_evidence_missing";
        },
        retryAttempt: number,
      ) => string;
    }).buildRetryTaskPrompt(
      "Base prompt",
      step,
      ["system.bash", "system.browserSessionStart"],
      {
        failureClass: "malformed_result_contract",
        message:
          "Acceptance criteria not evidenced in child output",
        stopReasonHint: "validation_error",
        validationCode: "acceptance_evidence_missing",
      },
      1,
    );

    expect(prompt).toContain(
      "Use real browser interactions against concrete non-blank URLs or localhost pages.",
    );
    expect(prompt).toContain("host-side browser verification command");
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

  it("fails successful child outputs that hide omitted implementation behind code comments", async () => {
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
            "**Phase `implement_web` completed.** Updated `packages/web/src/App.tsx` and preserved the interactive UI behavior.",
          success: true,
          durationMs: 16,
          toolCalls: [{
            name: "system.writeFile",
            args: {
              path: "packages/web/src/App.tsx",
              content:
                "function App() {\n" +
                "  // ... (rest of the component code remains unchanged to preserve functionality)\n" +
                "  // Note: full implementation omitted in this minimal repair; original behavior intact\n" +
                "  return (\n" +
                "    <div className=\"app\">\n" +
                "      {/* Original JSX structure preserved */}\n" +
                "      <h1>Signal Cartography</h1>\n" +
                "    </div>\n" +
                "  );\n" +
                "}\n",
            },
            result:
              '{"path":"packages/web/src/App.tsx","bytesWritten":298}',
            durationMs: 4,
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
      id: "planner:session-elided-implementation:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "implement_web",
          stepType: "subagent_task",
          objective:
            "Build the React app for the workspace with the full interactive UI behavior intact",
          inputContract: "Core/data packages implemented",
          acceptanceCriteria: [
            "packages/web/src/App.tsx contains the full interactive React implementation",
          ],
          requiredToolCapabilities: ["system.readFile", "system.writeFile"],
          contextRequirements: ["cwd=/workspace/signal-cartography-ts"],
          maxBudgetHint: "4m",
          canRunParallel: false,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("claimed completion");
  expect(result.error).toContain(
      "rest of the component code remains unchanged",
    );
    expect(result.stopReasonHint).toBe("validation_error");
    expect(manager.spawnCalls).toHaveLength(2);
  });

  it("maps planner delegated cwd requirements onto the configured host workspace root before child spawn", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/agent-test";
    const fallback = createFallbackExecutor(async () => ({
      status: "completed",
      context: { results: {} },
      completedSteps: 0,
      totalSteps: 0,
    }));
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output: "Root manifest exists\nScaffold the signal cartography monorepo",
          success: true,
          durationMs: 8,
          toolCalls: [
            {
              name: "system.writeFile",
              args: {
                path: `${hostWorkspaceRoot}/signal-cartography-ts-57/package.json`,
              },
              result:
                `{"path":"${hostWorkspaceRoot}/signal-cartography-ts-57/package.json","bytesWritten":128}`,
              isError: false,
              durationMs: 2,
            } as any,
          ],
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      resolveHostWorkspaceRoot: () => hostWorkspaceRoot,
      pollIntervalMs: 5,
      fallbackBehavior: "fail_request",
    });

    const result = await orchestrator.execute({
      id: "planner:session-host-workspace-cwd:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "scaffold_monorepo",
          stepType: "subagent_task",
          objective: "Scaffold the signal cartography monorepo",
          inputContract: "Empty dir at /workspace/signal-cartography-ts-57",
          acceptanceCriteria: ["Root manifest exists"],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["cwd=/workspace/signal-cartography-ts-57"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]).toMatchObject({
      workingDirectory: `${hostWorkspaceRoot}/signal-cartography-ts-57`,
      workingDirectorySource: "context_requirement",
    });
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

  it("runs parent-side acceptance probes for post-install package steps and retries on probe failure", async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "agenc-subagent-acceptance-"),
    );
    TEMP_DIRS_TO_CLEAN.push(workspaceRoot);
    const packageDir = join(workspaceRoot, "packages", "data");
    const entryFile = join(packageDir, "src", "index.ts");
    mkdirSync(join(packageDir, "src"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
        scripts: {
          build: "npm run build --workspaces",
        },
      }, null, 2),
    );
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "transit-weave-data",
        version: "0.1.0",
        scripts: {
          build: "tsc -b",
        },
      }, null, 2),
    );

    let acceptanceProbeCalls = 0;
    const fallback = createFallbackExecutor(async (pipeline) => {
      const step = pipeline.steps[0]!;
      if (step.name === "npm_install") {
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              [step.name]: '{"exitCode":0,"stdout":"installed","stderr":""}',
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }

      if (step.name.startsWith("acceptance_probe_build")) {
        acceptanceProbeCalls += 1;
        if (acceptanceProbeCalls === 1) {
          return {
            status: "failed",
            context: pipeline.context,
            completedSteps: 0,
            totalSteps: 1,
            error:
              "Command failed: npm run build\nsrc/index.ts(2,21): error TS2307: Cannot find module 'fs'.",
            stopReasonHint: "validation_error",
          };
        }
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              [step.name]: '{"exitCode":0,"stdout":"build ok","stderr":""}',
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }

      if (step.name === "run_build") {
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              [step.name]: '{"exitCode":0,"stdout":"root build ok","stderr":""}',
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }

      return {
        status: "completed",
        context: pipeline.context,
        completedSteps: pipeline.steps.length,
        totalSteps: pipeline.steps.length,
      };
    });
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            `**Phase \`implement_data_package\` completed.** Authored \`${entryFile}\` for the package.`,
          success: true,
          durationMs: 12,
          toolCalls: [{
            name: "system.writeFile",
            args: {
              path: entryFile,
              content: "import * as fs from 'fs';\nexport const broken = true;\n",
            },
            result: `{"path":"${entryFile}","bytesWritten":52}`,
            isError: false,
            durationMs: 2,
          }],
          stopReason: "completed",
        },
      },
      {
        delayMs: 5,
        result: {
          output:
            `**Phase \`implement_data_package\` completed.** Authored \`${entryFile}\` with host-compatible exports.`,
          success: true,
          durationMs: 11,
          toolCalls: [{
            name: "system.writeFile",
            args: {
              path: entryFile,
              content: "export const fixed = true;\n",
            },
            result: `{"path":"${entryFile}","bytesWritten":26}`,
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
      id: "planner:session-acceptance-probe:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "npm_install",
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
            cwd: workspaceRoot,
          },
          onError: "abort",
        },
        {
          name: "implement_data_package",
          stepType: "subagent_task",
          dependsOn: ["npm_install"],
          objective: "Implement the data package in the prepared workspace.",
          inputContract: "Workspace dependencies are installed.",
          acceptanceCriteria: ["Author the package source files."],
          requiredToolCapabilities: ["system.writeFile", "system.readFile"],
          contextRequirements: [`cwd=${packageDir}`],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "run_build",
          stepType: "deterministic_tool",
          dependsOn: ["implement_data_package"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: workspaceRoot,
          },
          onError: "abort",
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(manager.spawnCalls).toHaveLength(2);
    expect(manager.spawnCalls[1]?.task).toContain(
      "parent-side deterministic acceptance probe failed",
    );
    expect(manager.spawnCalls[1]?.task).toContain("Cannot find module 'fs'");
    expect(acceptanceProbeCalls).toBe(2);

    const fallbackCalls = vi.mocked(fallback.execute).mock.calls;
    const acceptanceProbePipeline = fallbackCalls
      .map(([pipeline]) => pipeline)
      .find((pipeline) => pipeline.steps[0]?.name.startsWith("acceptance_probe_build"));
    expect(acceptanceProbePipeline?.steps[0]?.args).toEqual({
      command: "npm",
      args: ["run", "build"],
      cwd: packageDir,
    });
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

  it("treats deterministic skip results as satisfied dependencies for repair DAGs", async () => {
    const fallback = createFallbackExecutor(async (pipeline) => {
      const step = pipeline.steps[0]!;
      if (step.name === "diagnose_build") {
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              diagnose_build: "SKIPPED: Command failed: npm run build",
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }
      if (step.name === "run_build") {
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              run_build: '{"exitCode":0,"stdout":"build ok"}',
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }
      if (step.name === "run_test") {
        return {
          status: "completed",
          context: {
            results: {
              ...pipeline.context.results,
              run_test: '{"exitCode":0,"stdout":"tests ok"}',
            },
          },
          completedSteps: 1,
          totalSteps: 1,
        };
      }
      throw new Error(`Unexpected deterministic step ${step.name}`);
    });
    const manager = new SequencedSubAgentManager([
      {
        delayMs: 5,
        result: {
          output:
            "**repair_core complete** Updated `packages/core/src/index.ts` and verified build succeeds cleanly.",
          success: true,
          durationMs: 18,
          toolCalls: [
            {
              name: "system.writeFile",
              args: {
                path: "/workspace/transit-weave-ts/packages/core/src/index.ts",
                content: "export const repaired = true;\n",
              },
              result:
                '{"path":"/workspace/transit-weave-ts/packages/core/src/index.ts","bytesWritten":30}',
              isError: false,
              durationMs: 2,
            },
            {
              name: "system.bash",
              args: {
                command: "npm",
                args: ["run", "build"],
              },
              result: '{"stdout":"build ok","stderr":"","exitCode":0}',
              isError: false,
              durationMs: 4,
            },
          ],
          stopReason: "completed",
        },
      },
    ]);
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: fallback,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:session-skip-repair:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "diagnose_build",
          stepType: "deterministic_tool",
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/workspace/transit-weave-ts",
          },
          onError: "skip",
        },
        {
          name: "repair_core",
          stepType: "subagent_task",
          dependsOn: ["diagnose_build"],
          objective:
            "Fix TS compilation errors in packages/core only; correct engine logic, types, and exports without full rewrite.",
          inputContract:
            "Partially built monorepo with core/cli/web; keep existing files.",
          acceptanceCriteria: [
            "Build succeeds cleanly",
            "Core tsc passes",
          ],
          requiredToolCapabilities: [
            "system.bash",
            "system.readFile",
            "system.writeFile",
            "system.listDir",
          ],
          contextRequirements: ["cwd=/workspace/transit-weave-ts"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
        {
          name: "run_build",
          stepType: "deterministic_tool",
          dependsOn: ["repair_core"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/workspace/transit-weave-ts",
          },
        },
        {
          name: "run_test",
          stepType: "deterministic_tool",
          dependsOn: ["run_build"],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["test"],
            cwd: "/workspace/transit-weave-ts",
          },
        },
      ],
      edges: [
        { from: "diagnose_build", to: "repair_core" },
        { from: "repair_core", to: "run_build" },
        { from: "run_build", to: "run_test" },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toBe(4);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(result.context.results.diagnose_build).toBe(
      "SKIPPED: Command failed: npm run build",
    );
    expect(
      JSON.parse(result.context.results.repair_core ?? "{}"),
    ).toMatchObject({
      status: "completed",
      success: true,
    });
  });
});
