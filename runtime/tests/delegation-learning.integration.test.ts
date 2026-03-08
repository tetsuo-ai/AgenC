import { describe, expect, it, vi } from "vitest";
import { ChatExecutor } from "../src/llm/chat-executor.js";
import type { LLMProvider, LLMResponse, LLMMessage } from "../src/llm/types.js";
import {
  DelegationBanditPolicyTuner,
  InMemoryDelegationTrajectorySink,
} from "../src/llm/delegation-learning.js";
import { SubAgentOrchestrator } from "../src/gateway/subagent-orchestrator.js";
import type { Pipeline, PipelineResult } from "../src/workflow/pipeline.js";
import type { SubAgentConfig, SubAgentResult } from "../src/gateway/sub-agent.js";

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "ok",
    toolCalls: [],
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    finishReason: "stop",
    model: "mock-model",
    ...overrides,
  };
}

function createProvider(chatImpl: (messages: LLMMessage[]) => Promise<LLMResponse>): LLMProvider {
  return {
    name: "primary",
    chat: vi.fn(chatImpl),
    chatStream: vi.fn(async () => response()),
    healthCheck: vi.fn(async () => true),
  };
}

function createMessage(content: string) {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm" as const,
  };
}

class FastSubAgentManager {
  private seq = 0;
  private readonly results = new Map<string, SubAgentResult>();

  async spawn(config: SubAgentConfig): Promise<string> {
    const id = `sub-${++this.seq}`;
    this.results.set(id, {
      sessionId: id,
      output: JSON.stringify({
        status: "ok",
        task: config.task.slice(0, 24),
        coverage: ["runtime learning hooks"],
      }),
      success: true,
      durationMs: 15,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "runtime/src/llm/delegation-learning.ts" },
          result: '{"path":"runtime/src/llm/delegation-learning.ts","content":"coverage: runtime learning hooks"}',
          isError: false,
          durationMs: 5,
        },
      ],
      tokenUsage: {
        promptTokens: 40,
        completionTokens: 20,
        totalTokens: 60,
      },
    });
    return id;
  }

  getResult(sessionId: string): SubAgentResult | null {
    return this.results.get(sessionId) ?? null;
  }
}

function createFallbackExecutor(): { execute: (pipeline: Pipeline) => Promise<PipelineResult> } {
  return {
    execute: async (pipeline: Pipeline) => {
      const step = pipeline.steps[0];
      if (!step) {
        return {
          status: "completed",
          context: pipeline.context,
          completedSteps: 0,
          totalSteps: 0,
        };
      }
      return {
        status: "completed",
        context: {
          results: {
            ...pipeline.context.results,
            [step.name]: JSON.stringify({ stdout: "ok", exitCode: 0 }),
          },
        },
        completedSteps: 1,
        totalSteps: 1,
      };
    },
  };
}

describe("delegation learning integration", () => {
  it("records parent trajectories and updates bandit routing after planner execution", async () => {
    const trajectorySink = new InMemoryDelegationTrajectorySink({ maxRecords: 100 });
    const bandit = new DelegationBanditPolicyTuner({
      enabled: true,
      epsilon: 0,
      minSamplesPerArm: 1,
      explorationBudget: 0,
      random: () => 0.99,
    });

    const plannerPlan = {
      reason: "multi_step_cues",
      requiresSynthesis: false,
      steps: [
        {
          name: "prep",
          step_type: "deterministic_tool",
          tool: "system.readFile",
          args: { path: "README.md" },
        },
        {
          name: "child_a",
          step_type: "subagent_task",
          objective: "Analyze runtime orchestrator behavior",
          input_contract: "Return JSON evidence",
          acceptance_criteria: ["Include findings", "Include citations"],
          required_tool_capabilities: ["system.readFile", "system.searchFiles"],
          context_requirements: ["runtime_sources", "planner_history"],
          max_budget_hint: "90s",
          can_run_parallel: true,
          depends_on: ["prep"],
        },
        {
          name: "child_b",
          step_type: "subagent_task",
          objective: "Analyze gateway wiring behavior",
          input_contract: "Return JSON evidence",
          acceptance_criteria: ["Include findings", "Include citations"],
          required_tool_capabilities: ["system.readFile", "system.searchFiles"],
          context_requirements: ["gateway_sources", "planner_history"],
          max_budget_hint: "90s",
          can_run_parallel: true,
          depends_on: ["prep"],
        },
      ],
      edges: [
        { from: "prep", to: "child_a" },
        { from: "prep", to: "child_b" },
      ],
    };

    const provider = createProvider(async () =>
      response({ content: JSON.stringify(plannerPlan) })
    );

    const pipelineExecutor = {
      execute: vi.fn(async () => ({
        status: "completed",
        context: {
          results: {
            prep: JSON.stringify({ stdout: "ok", exitCode: 0 }),
            child_a: JSON.stringify({
              status: "completed",
              subagentSessionId: "sub-a",
              output: "analysis-a",
              success: true,
              durationMs: 200,
              toolCalls: [],
              tokenUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
            child_b: JSON.stringify({
              status: "completed",
              subagentSessionId: "sub-b",
              output: "analysis-b",
              success: true,
              durationMs: 180,
              toolCalls: [],
              tokenUsage: { promptTokens: 18, completionTokens: 8, totalTokens: 26 },
            }),
          },
        },
        completedSteps: 3,
        totalSteps: 3,
      })),
    };

    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn(async () => "unused"),
      plannerEnabled: true,
      pipelineExecutor,
      delegationDecision: {
        enabled: true,
        scoreThreshold: 0.2,
        maxFanoutPerTurn: 8,
        maxDepth: 4,
      },
      delegationLearning: {
        trajectorySink,
        banditTuner: bandit,
        defaultStrategyArmId: "balanced",
      },
    });

    const result = await executor.execute({
      message: createMessage(
        "First analyze runtime orchestration and gateway wiring, then compare outcomes and summarize reliability deltas with evidence.",
      ),
      history: [
        { role: "user", content: "Previous context on planner regressions" },
      ],
      systemPrompt: "You are an assistant.",
      sessionId: "session-1",
    });

    expect(result.plannerSummary?.used).toBe(true);
    expect(result.plannerSummary?.delegationDecision?.shouldDelegate).toBe(true);
    expect(result.plannerSummary?.delegationPolicyTuning?.selectedArmId).toBeDefined();
    expect(result.plannerSummary?.delegationPolicyTuning?.finalReward).toBeTypeOf("number");

    const records = trajectorySink.snapshot();
    expect(records.length).toBeGreaterThan(0);

    const parent = records.find((entry) => entry.turnType === "parent");
    expect(parent).toBeDefined();
    expect(parent?.action.delegated).toBe(true);
    expect(parent?.stateFeatures.subagentStepCount).toBe(2);
    expect(Number.isFinite(parent?.finalReward.value ?? Number.NaN)).toBe(true);

    const clusterId = parent?.stateFeatures.contextClusterId;
    expect(clusterId).toBeDefined();
    const snapshot = bandit.snapshot({ contextClusterId: clusterId });
    const arms = snapshot[clusterId!];
    expect(arms).toBeDefined();
    expect((arms ?? []).some((arm) => arm.pulls > 0)).toBe(true);
  });

  it("records child trajectories from orchestrator-executed subagent steps", async () => {
    const trajectorySink = new InMemoryDelegationTrajectorySink({ maxRecords: 100 });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: createFallbackExecutor(),
      resolveSubAgentManager: () => new FastSubAgentManager(),
      resolveTrajectorySink: () => trajectorySink,
      allowParallelSubtasks: true,
      maxParallelSubtasks: 2,
      pollIntervalMs: 1,
    });

    const pipeline: Pipeline = {
      id: "planner:session-integration:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerSteps: [
        {
          name: "delegate_runtime",
          stepType: "subagent_task",
          objective: "Inspect runtime learning hooks",
          inputContract: "Return JSON output",
          acceptanceCriteria: ["Include coverage"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "30s",
          canRunParallel: true,
        },
      ],
    };

    const result = await orchestrator.execute(pipeline);

    expect(result.status).toBe("completed");
    const records = trajectorySink.snapshot();
    expect(records.length).toBeGreaterThan(0);

    const child = records.find((entry) => entry.turnType === "child");
    expect(child).toBeDefined();
    expect(child?.action.delegated).toBe(true);
    expect(child?.action.selectedTools).toContain("system.readFile");
    expect(child?.immediateOutcome.errorCount).toBe(0);
    expect(child?.finalReward.value).toBeGreaterThan(0);
  });
});
